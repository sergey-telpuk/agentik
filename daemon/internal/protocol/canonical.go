// Package protocol defines the wire contracts that both sides of an Agentik
// connection must agree on byte for byte: the canonical encoding used for
// signed structures, the relay registration challenge, and the Noise prologue.
//
// Nothing here depends on a transport or on a storage engine. The encoding is
// deliberately explicit: JSON field order is not a signing contract, so signed
// payloads are built from length-prefixed fields in a fixed order.
package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// Version is the protocol version carried in the outer envelope, the QR
// payload, and every signed context string. A peer that does not recognise it
// must reject the message rather than guess.
const Version uint16 = 1

// Signing context strings. A signature is only ever valid for the one purpose
// its context names, so a registration signature cannot be replayed as a
// pairing signature.
const (
	// ContextRelayRegister authenticates a device taking ownership of its
	// relay route.
	ContextRelayRegister = "agentik-relay-register-v1"
	// ContextPairingDescriptor authenticates the QR pairing descriptor that
	// binds a device's two public keys together.
	ContextPairingDescriptor = "agentik-pairing-descriptor-v1"
	// ContextNoisePrologue binds a Noise handshake to this protocol, the
	// peer roles, and the target device.
	ContextNoisePrologue = "agentik-noise-prologue-v1"
)

// maxFieldLen bounds a single canonical field. Signed structures carry keys,
// identifiers, and challenges, never bulk data, so a small bound is correct
// and keeps a malformed length from driving a large allocation on decode.
const maxFieldLen = 1 << 16

var (
	// ErrFieldTooLong is returned when a field exceeds maxFieldLen.
	ErrFieldTooLong = errors.New("protocol: canonical field exceeds maximum length")
	// ErrTruncated is returned when a buffer ends mid-field.
	ErrTruncated = errors.New("protocol: canonical buffer truncated")
	// ErrTrailingBytes is returned when a buffer holds more data than the
	// structure being decoded accounts for.
	ErrTrailingBytes = errors.New("protocol: canonical buffer has trailing bytes")
)

// Encoder builds a canonical byte string from a fixed sequence of fields.
//
// Every field is length-prefixed, so no concatenation of one field's value
// with another's can produce the same bytes as a different field sequence.
// That property is what makes the output safe to sign: two distinct
// structures never share an encoding.
//
// The first error encountered is retained and returned by Bytes; callers do
// not need to check each Add call.
type Encoder struct {
	buf []byte
	err error
}

// NewEncoder returns an Encoder that starts with the given context string.
//
// The context is written as an ordinary length-prefixed field, which domain-
// separates every signature produced from this encoder.
func NewEncoder(context string) *Encoder {
	e := &Encoder{buf: make([]byte, 0, 128)}
	e.AddString(context)
	return e
}

// AddBytes appends a length-prefixed byte field.
func (e *Encoder) AddBytes(v []byte) *Encoder {
	if e.err != nil {
		return e
	}
	if len(v) > maxFieldLen {
		e.err = fmt.Errorf("%w: %d bytes", ErrFieldTooLong, len(v))
		return e
	}
	e.buf = binary.BigEndian.AppendUint32(e.buf, uint32(len(v)))
	e.buf = append(e.buf, v...)
	return e
}

// AddString appends a length-prefixed string field.
func (e *Encoder) AddString(v string) *Encoder {
	return e.AddBytes([]byte(v))
}

// AddUint16 appends a fixed-width 16-bit field.
//
// Fixed-width numbers are written without a length prefix because their width
// is part of the structure definition and cannot vary between encodings.
func (e *Encoder) AddUint16(v uint16) *Encoder {
	if e.err != nil {
		return e
	}
	e.buf = binary.BigEndian.AppendUint16(e.buf, v)
	return e
}

// AddUint64 appends a fixed-width 64-bit field.
func (e *Encoder) AddUint64(v uint64) *Encoder {
	if e.err != nil {
		return e
	}
	e.buf = binary.BigEndian.AppendUint64(e.buf, v)
	return e
}

// AddInt64 appends a signed 64-bit field, used for Unix timestamps.
//
// The value is encoded as its two's-complement bit pattern so that negative
// timestamps round-trip rather than wrapping into an unrelated positive value.
func (e *Encoder) AddInt64(v int64) *Encoder {
	return e.AddUint64(uint64(v))
}

// Bytes returns the encoded buffer, or the first error encountered.
func (e *Encoder) Bytes() ([]byte, error) {
	if e.err != nil {
		return nil, e.err
	}
	out := make([]byte, len(e.buf))
	copy(out, e.buf)
	return out, nil
}

// MustBytes returns the encoded buffer and panics on error.
//
// It is intended for encoding values the caller has already validated, such as
// fixed-size public keys, where an error would indicate a programming mistake
// rather than bad input.
func (e *Encoder) MustBytes() []byte {
	out, err := e.Bytes()
	if err != nil {
		panic(err)
	}
	return out
}

// Decoder reads fields written by Encoder, in the same order.
//
// A decoder is only used where a canonical structure must be parsed back, such
// as a QR payload. Signature verification re-encodes the structure instead of
// decoding the signed bytes, so that verification never depends on a parser
// accepting exactly what the encoder produced.
type Decoder struct {
	buf []byte
	pos int
}

// NewDecoder returns a Decoder over buf.
func NewDecoder(buf []byte) *Decoder {
	return &Decoder{buf: buf}
}

// Bytes reads the next length-prefixed field.
func (d *Decoder) Bytes() ([]byte, error) {
	if d.pos+4 > len(d.buf) {
		return nil, ErrTruncated
	}
	n := binary.BigEndian.Uint32(d.buf[d.pos:])
	if n > maxFieldLen {
		return nil, fmt.Errorf("%w: %d bytes", ErrFieldTooLong, n)
	}
	d.pos += 4
	// n is bounded by maxFieldLen above, so the conversion cannot overflow.
	end := d.pos + int(n)
	if end > len(d.buf) {
		return nil, ErrTruncated
	}
	out := make([]byte, n)
	copy(out, d.buf[d.pos:end])
	d.pos = end
	return out, nil
}

// String reads the next length-prefixed field as a string.
func (d *Decoder) String() (string, error) {
	b, err := d.Bytes()
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Uint16 reads a fixed-width 16-bit field.
func (d *Decoder) Uint16() (uint16, error) {
	if d.pos+2 > len(d.buf) {
		return 0, ErrTruncated
	}
	v := binary.BigEndian.Uint16(d.buf[d.pos:])
	d.pos += 2
	return v, nil
}

// Uint64 reads a fixed-width 64-bit field.
func (d *Decoder) Uint64() (uint64, error) {
	if d.pos+8 > len(d.buf) {
		return 0, ErrTruncated
	}
	v := binary.BigEndian.Uint64(d.buf[d.pos:])
	d.pos += 8
	return v, nil
}

// Int64 reads a signed 64-bit field.
//
// The conversion reinterprets the two's-complement bit pattern written by
// AddInt64, so negative values round-trip exactly.
func (d *Decoder) Int64() (int64, error) {
	v, err := d.Uint64()
	if err != nil {
		return 0, err
	}
	return int64(v), nil
}

// Finish reports whether the whole buffer was consumed.
//
// Callers use it to reject input that carries unexpected trailing bytes, which
// would otherwise let two different buffers decode to the same structure.
func (d *Decoder) Finish() error {
	if d.pos != len(d.buf) {
		return fmt.Errorf("%w: %d unread", ErrTrailingBytes, len(d.buf)-d.pos)
	}
	return nil
}
