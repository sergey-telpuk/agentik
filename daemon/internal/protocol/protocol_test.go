package protocol

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

// TestCanonicalEncodingIsUnambiguous is the core property that makes the
// encoding safe to sign: two different field sequences must never produce the
// same bytes. Without length prefixes, ("ab", "c") and ("a", "bc") would
// collide and a signature over one would validate the other.
func TestCanonicalEncodingIsUnambiguous(t *testing.T) {
	a := NewEncoder("ctx").AddString("ab").AddString("c").MustBytes()
	b := NewEncoder("ctx").AddString("a").AddString("bc").MustBytes()
	if bytes.Equal(a, b) {
		t.Fatal("different field splits produced identical encodings")
	}
}

// TestCanonicalContextSeparates checks that the same fields under different
// contexts encode differently, so a signature made for one purpose cannot be
// replayed for another.
func TestCanonicalContextSeparates(t *testing.T) {
	a := NewEncoder(ContextRelayRegister).AddString("x").MustBytes()
	b := NewEncoder(ContextPairingDescriptor).AddString("x").MustBytes()
	if bytes.Equal(a, b) {
		t.Fatal("different contexts produced identical encodings")
	}
}

func TestCanonicalRoundTrip(t *testing.T) {
	enc := NewEncoder("ctx").
		AddString("hello").
		AddUint16(7).
		AddUint64(1 << 40).
		AddInt64(-12345).
		AddBytes([]byte{0x00, 0xff})
	buf := enc.MustBytes()

	d := NewDecoder(buf)
	if ctx, err := d.String(); err != nil || ctx != "ctx" {
		t.Fatalf("context = %q, %v", ctx, err)
	}
	if s, err := d.String(); err != nil || s != "hello" {
		t.Fatalf("string = %q, %v", s, err)
	}
	if v, err := d.Uint16(); err != nil || v != 7 {
		t.Fatalf("uint16 = %d, %v", v, err)
	}
	if v, err := d.Uint64(); err != nil || v != 1<<40 {
		t.Fatalf("uint64 = %d, %v", v, err)
	}
	if v, err := d.Int64(); err != nil || v != -12345 {
		t.Fatalf("int64 = %d, %v", v, err)
	}
	if b, err := d.Bytes(); err != nil || !bytes.Equal(b, []byte{0x00, 0xff}) {
		t.Fatalf("bytes = %x, %v", b, err)
	}
	if err := d.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}
}

func TestDecoderRejectsTruncatedAndTrailing(t *testing.T) {
	buf := NewEncoder("ctx").AddString("value").MustBytes()

	d := NewDecoder(buf[:len(buf)-2])
	if _, err := d.String(); err != nil {
		t.Fatalf("reading context: %v", err)
	}
	if _, err := d.String(); !errors.Is(err, ErrTruncated) {
		t.Fatalf("truncated buffer: got %v, want ErrTruncated", err)
	}

	d = NewDecoder(append(bytes.Clone(buf), 0x00))
	_, _ = d.String()
	_, _ = d.String()
	if err := d.Finish(); !errors.Is(err, ErrTrailingBytes) {
		t.Fatalf("trailing bytes: got %v, want ErrTrailingBytes", err)
	}
}

// TestDecoderRejectsOversizedLength ensures a hostile length prefix is
// rejected by the bound rather than driving a large allocation.
func TestDecoderRejectsOversizedLength(t *testing.T) {
	buf := []byte{0xff, 0xff, 0xff, 0xff}
	if _, err := NewDecoder(buf).Bytes(); !errors.Is(err, ErrFieldTooLong) {
		t.Fatalf("got %v, want ErrFieldTooLong", err)
	}
}

func TestInt64RoundTripExtremes(t *testing.T) {
	for _, v := range []int64{0, 1, -1, 1 << 62, -(1 << 62), 1<<63 - 1, -1 << 63} {
		buf := NewEncoder("c").AddInt64(v).MustBytes()
		d := NewDecoder(buf)
		if _, err := d.String(); err != nil {
			t.Fatal(err)
		}
		got, err := d.Int64()
		if err != nil {
			t.Fatalf("Int64(%d): %v", v, err)
		}
		if got != v {
			t.Fatalf("Int64 round trip: got %d, want %d", got, v)
		}
	}
}

func newDevice(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return pub, priv
}

func newChallenge(t *testing.T) []byte {
	t.Helper()
	c := make([]byte, ChallengeSize)
	if _, err := rand.Read(c); err != nil {
		t.Fatalf("random challenge: %v", err)
	}
	return c
}

func validRequest(t *testing.T, now time.Time) (*RegisterRequest, ed25519.PrivateKey, []byte) {
	t.Helper()
	pub, priv := newDevice(t)
	challenge := newChallenge(t)
	req := &RegisterRequest{
		Version:           Version,
		Role:              RoleDevice,
		RelayID:           "relay.example",
		DeviceID:          DeviceIDFromKey(pub),
		RegisterPublicKey: pub,
		Challenge:         challenge,
		ExpiresAt:         now.Add(30 * time.Second),
	}
	if err := req.Sign(priv); err != nil {
		t.Fatalf("sign: %v", err)
	}
	return req, priv, challenge
}

func TestRegisterRequestVerifies(t *testing.T) {
	now := time.Now()
	req, _, challenge := validRequest(t, now)
	if err := req.Verify("relay.example", challenge, now); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

// TestRegisterRequestRejectsForeignKey covers the acceptance check "spoofed PC
// or relay registration": a signature from another key must not grant the
// route, even when every other field is well formed.
func TestRegisterRequestRejectsForeignKey(t *testing.T) {
	now := time.Now()
	req, _, challenge := validRequest(t, now)

	_, attacker := newDevice(t)
	msg, err := req.signingBytes()
	if err != nil {
		t.Fatal(err)
	}
	req.Signature = ed25519.Sign(attacker, msg)

	if err := req.Verify("relay.example", challenge, now); !errors.Is(err, ErrSignature) {
		t.Fatalf("got %v, want ErrSignature", err)
	}
}

// TestRegisterRequestRejectsWrongChallenge covers replay of a registration
// captured on a different socket.
func TestRegisterRequestRejectsWrongChallenge(t *testing.T) {
	now := time.Now()
	req, _, _ := validRequest(t, now)
	other := newChallenge(t)
	if err := req.Verify("relay.example", other, now); !errors.Is(err, ErrMalformed) {
		t.Fatalf("got %v, want ErrMalformed", err)
	}
}

// TestRegisterRequestRejectsWrongRelay stops a signature captured by one relay
// from being presented to another.
func TestRegisterRequestRejectsWrongRelay(t *testing.T) {
	now := time.Now()
	req, _, challenge := validRequest(t, now)
	if err := req.Verify("other.example", challenge, now); !errors.Is(err, ErrMalformed) {
		t.Fatalf("got %v, want ErrMalformed", err)
	}
}

// TestRegisterRequestRejectsMismatchedDeviceID ensures a request cannot claim
// another device's address: the id is recomputed from the key, not trusted.
func TestRegisterRequestRejectsMismatchedDeviceID(t *testing.T) {
	now := time.Now()
	req, priv, challenge := validRequest(t, now)

	otherPub, _ := newDevice(t)
	req.DeviceID = DeviceIDFromKey(otherPub)
	if err := req.Sign(priv); err != nil {
		t.Fatalf("sign: %v", err)
	}

	if err := req.Verify("relay.example", challenge, now); !errors.Is(err, ErrMalformed) {
		t.Fatalf("got %v, want ErrMalformed", err)
	}
}

func TestRegisterRequestExpiry(t *testing.T) {
	now := time.Now()
	req, _, challenge := validRequest(t, now)

	if err := req.Verify("relay.example", challenge, now.Add(time.Hour)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired: got %v, want ErrExpired", err)
	}

	// An expiry far in the future implies an unusable clock on the peer, and
	// would otherwise let one signature stay valid indefinitely.
	if err := req.Verify("relay.example", challenge, now.Add(-time.Hour)); !errors.Is(err, ErrNotYetValid) {
		t.Fatalf("skew: got %v, want ErrNotYetValid", err)
	}
}

// TestRegisterRequestTamperedFields checks that every signed field actually
// participates in the signature. A field left out of signingBytes would let
// an attacker alter it in transit undetected.
func TestRegisterRequestTamperedFields(t *testing.T) {
	now := time.Now()
	tamper := map[string]func(*RegisterRequest){
		"relay id":  func(r *RegisterRequest) { r.RelayID = "evil.example" },
		"expiry":    func(r *RegisterRequest) { r.ExpiresAt = r.ExpiresAt.Add(time.Minute) },
		"challenge": func(r *RegisterRequest) { r.Challenge[0] ^= 0xff },
		"device id": func(r *RegisterRequest) { r.DeviceID[0] ^= 0xff },
	}
	for name, mutate := range tamper {
		t.Run(name, func(t *testing.T) {
			req, _, challenge := validRequest(t, now)
			mutate(req)
			// Verify against whatever the request now claims, so that the
			// only thing left to catch the change is the signature itself.
			err := req.Verify(req.RelayID, challenge, now)
			if err == nil {
				t.Fatal("tampered request verified")
			}
		})
	}
}

func TestSignRejectsMismatchedKeyPair(t *testing.T) {
	now := time.Now()
	pub, _ := newDevice(t)
	_, otherPriv := newDevice(t)
	req := &RegisterRequest{
		Version:           Version,
		Role:              RoleDevice,
		RelayID:           "relay.example",
		DeviceID:          DeviceIDFromKey(pub),
		RegisterPublicKey: pub,
		Challenge:         newChallenge(t),
		ExpiresAt:         now.Add(time.Minute),
	}
	if err := req.Sign(otherPriv); !errors.Is(err, ErrMalformed) {
		t.Fatalf("got %v, want ErrMalformed", err)
	}
}

func validDescriptor(t *testing.T, now time.Time) (*PairingDescriptor, ed25519.PrivateKey) {
	t.Helper()
	pub, priv := newDevice(t)
	noiseKey := make([]byte, NoiseKeySize)
	if _, err := rand.Read(noiseKey); err != nil {
		t.Fatal(err)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(secret)
	d := &PairingDescriptor{
		Version:           Version,
		RelayURL:          "wss://relay.example/v1",
		DeviceID:          DeviceIDFromKey(pub),
		RegisterPublicKey: pub,
		NoisePublicKey:    noiseKey,
		InvitationHash:    hash[:],
		ExpiresAt:         now.Add(10 * time.Minute),
	}
	if err := d.Sign(priv); err != nil {
		t.Fatalf("sign: %v", err)
	}
	return d, priv
}

func TestPairingDescriptorVerifies(t *testing.T) {
	now := time.Now()
	d, _ := validDescriptor(t, now)
	if err := d.Verify(now); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

// TestPairingDescriptorRejectsSwappedNoiseKey is the pin-substitution check:
// a relay that replaced the Noise key with its own would have to forge a
// signature made by the registration key.
func TestPairingDescriptorRejectsSwappedNoiseKey(t *testing.T) {
	now := time.Now()
	d, _ := validDescriptor(t, now)
	attackerKey := make([]byte, NoiseKeySize)
	if _, err := rand.Read(attackerKey); err != nil {
		t.Fatal(err)
	}
	d.NoisePublicKey = attackerKey
	if err := d.Verify(now); !errors.Is(err, ErrSignature) {
		t.Fatalf("got %v, want ErrSignature", err)
	}
}

// TestPairingDescriptorExpiredInvitation covers the acceptance check that a
// retry with an expired invitation grants no access.
func TestPairingDescriptorExpiredInvitation(t *testing.T) {
	now := time.Now()
	d, _ := validDescriptor(t, now)
	if err := d.Verify(now.Add(time.Hour)); !errors.Is(err, ErrExpired) {
		t.Fatalf("got %v, want ErrExpired", err)
	}
}

func TestDeviceIDRoundTrip(t *testing.T) {
	pub, _ := newDevice(t)
	id := DeviceIDFromKey(pub)
	parsed, err := ParseDeviceID(FormatDeviceID(id))
	if err != nil {
		t.Fatalf("ParseDeviceID: %v", err)
	}
	if !bytes.Equal(parsed, id) {
		t.Fatalf("round trip mismatch")
	}
}

func TestParseDeviceIDRejectsBadInput(t *testing.T) {
	for _, s := range []string{"", "not-base32!", "aaaa"} {
		if _, err := ParseDeviceID(s); err == nil {
			t.Fatalf("ParseDeviceID(%q) accepted invalid input", s)
		}
	}
}

// TestNoisePrologueBinding checks that the prologue differs for every
// combination it is meant to separate. Noise authenticates the prologue, so a
// difference here is what makes a cross-device or cross-direction replay fail
// the handshake.
func TestNoisePrologueBinding(t *testing.T) {
	idA := DeviceIDFromKey(func() ed25519.PublicKey { p, _ := newDevice(t); return p }())
	idB := DeviceIDFromKey(func() ed25519.PublicKey { p, _ := newDevice(t); return p }())

	base := NoisePrologue(Version, RoleClient, RoleDevice, idA)
	cases := map[string][]byte{
		"other device":  NoisePrologue(Version, RoleClient, RoleDevice, idB),
		"swapped roles": NoisePrologue(Version, RoleDevice, RoleClient, idA),
		"other version": NoisePrologue(Version+1, RoleClient, RoleDevice, idA),
	}
	for name, other := range cases {
		if bytes.Equal(base, other) {
			t.Fatalf("%s: prologue did not change", name)
		}
	}
}

func TestRoleValid(t *testing.T) {
	if !RoleDevice.Valid() || !RoleClient.Valid() {
		t.Fatal("defined roles must be valid")
	}
	if Role("relay").Valid() {
		t.Fatal("undefined role accepted")
	}
}
