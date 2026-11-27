package secure

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"testing"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

func newStatic(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate static key: %v", err)
	}
	return k
}

func acceptAll([]byte) error { return nil }

// pair runs a full XX handshake and returns both sessions.
func pair(t *testing.T, initCfg, respCfg Config) (*Session, *Session, error) {
	t.Helper()

	initiator, err := NewHandshake(initCfg)
	if err != nil {
		return nil, nil, err
	}
	responder, err := NewHandshake(respCfg)
	if err != nil {
		return nil, nil, err
	}

	// XX is three messages: -> e, <- e ee s es, -> s se
	msg1, err := initiator.WriteMessage(nil)
	if err != nil {
		return nil, nil, err
	}
	if _, err := responder.ReadMessage(msg1); err != nil {
		return nil, nil, err
	}
	msg2, err := responder.WriteMessage(nil)
	if err != nil {
		return nil, nil, err
	}
	if _, err := initiator.ReadMessage(msg2); err != nil {
		return nil, nil, err
	}
	msg3, err := initiator.WriteMessage(nil)
	if err != nil {
		return nil, nil, err
	}
	if _, err := responder.ReadMessage(msg3); err != nil {
		return nil, nil, err
	}

	if !initiator.Complete() || !responder.Complete() {
		return nil, nil, errors.New("handshake did not complete on both sides")
	}
	initSession, err := initiator.Session()
	if err != nil {
		return nil, nil, err
	}
	respSession, err := responder.Session()
	if err != nil {
		return nil, nil, err
	}
	return initSession, respSession, nil
}

func configs(t *testing.T, prologue []byte) (Config, Config, *ecdh.PrivateKey, *ecdh.PrivateKey) {
	t.Helper()
	phone, device := newStatic(t), newStatic(t)
	return Config{
		Initiator:  true,
		StaticKey:  phone,
		Prologue:   prologue,
		VerifyPeer: acceptAll,
	}, Config{
		Initiator:  false,
		StaticKey:  device,
		Prologue:   prologue,
		VerifyPeer: acceptAll,
	}, phone, device
}

func TestHandshakeExchangesMessages(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, phone, device := configs(t, prologue)

	client, daemon, err := pair(t, initCfg, respCfg)
	if err != nil {
		t.Fatalf("handshake: %v", err)
	}

	// Each side must end up holding the other's real static key: that is
	// what the application checks against its pin and its paired clients.
	if !bytes.Equal(client.PeerStatic(), device.PublicKey().Bytes()) {
		t.Fatal("client did not receive the device's static key")
	}
	if !bytes.Equal(daemon.PeerStatic(), phone.PublicKey().Bytes()) {
		t.Fatal("daemon did not receive the phone's static key")
	}

	// Traffic must flow in both directions, each with its own key.
	msg := []byte(`{"method":"device.info"}`)
	sealed, err := client.Encrypt(msg)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed, msg) {
		t.Fatal("ciphertext contains the plaintext")
	}
	got, err := daemon.Decrypt(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatalf("decrypted %q, want %q", got, msg)
	}

	reply := []byte(`{"ok":true}`)
	sealed, err = daemon.Encrypt(reply)
	if err != nil {
		t.Fatal(err)
	}
	got, err = client.Decrypt(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, reply) {
		t.Fatalf("decrypted %q, want %q", got, reply)
	}
}

// TestPrologueMismatchFailsHandshake is what binds a session to one device
// and one direction: a handshake aimed at another device cannot complete here.
func TestPrologueMismatchFailsHandshake(t *testing.T) {
	initCfg, respCfg, _, _ := configs(t, DevicePrologue([]byte("device-a")))
	respCfg.Prologue = DevicePrologue([]byte("device-b"))

	if _, _, err := pair(t, initCfg, respCfg); err == nil {
		t.Fatal("handshake completed despite mismatched prologues")
	}
}

// TestResponderRejectsUnknownClient is the "unknown phone" acceptance check:
// the daemon declines a static key that is not a paired client, and no
// session is produced.
func TestResponderRejectsUnknownClient(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, _, _ := configs(t, prologue)

	rejection := errors.New("phone is not paired")
	respCfg.VerifyPeer = func([]byte) error { return rejection }

	_, _, err := pair(t, initCfg, respCfg)
	if err == nil {
		t.Fatal("handshake completed with an unknown client")
	}
	if !errors.Is(err, ErrPeerRejected) {
		t.Fatalf("got %v, want ErrPeerRejected", err)
	}
}

// TestInitiatorRejectsUnpinnedDevice is the pin-substitution check: if the
// device's static key is not the pinned one, the phone stops the handshake
// instead of accepting the new key.
func TestInitiatorRejectsUnpinnedDevice(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, _, device := configs(t, prologue)

	pinned := newStatic(t).PublicKey().Bytes()
	initCfg.VerifyPeer = func(key []byte) error {
		if !protocol.ConstantTimeEqual(key, pinned) {
			return errors.New("device key does not match the pinned key")
		}
		return nil
	}

	_, _, err := pair(t, initCfg, respCfg)
	if err == nil {
		t.Fatal("handshake completed against an unpinned device key")
	}
	if !errors.Is(err, ErrPeerRejected) {
		t.Fatalf("got %v, want ErrPeerRejected", err)
	}

	// The same configuration must succeed once the real key is pinned,
	// confirming the rejection was about the key and not a broken setup.
	initCfg.VerifyPeer = func(key []byte) error {
		if !protocol.ConstantTimeEqual(key, device.PublicKey().Bytes()) {
			return errors.New("unexpected key")
		}
		return nil
	}
	if _, _, err := pair(t, initCfg, respCfg); err != nil {
		t.Fatalf("handshake with the correct pin failed: %v", err)
	}
}

// TestVerifyPeerRunsOnce guards against the callback being consulted again
// after it has accepted a key, which could let a later message swap it.
func TestVerifyPeerRunsOnce(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, _, _ := configs(t, prologue)

	var initCalls, respCalls int
	initCfg.VerifyPeer = func([]byte) error { initCalls++; return nil }
	respCfg.VerifyPeer = func([]byte) error { respCalls++; return nil }

	if _, _, err := pair(t, initCfg, respCfg); err != nil {
		t.Fatal(err)
	}
	if initCalls != 1 {
		t.Fatalf("initiator verified the peer %d times, want 1", initCalls)
	}
	if respCalls != 1 {
		t.Fatalf("responder verified the peer %d times, want 1", respCalls)
	}
}

// TestNoSessionBeforeHandshakeCompletes enforces the rule that commands are
// only accepted after the full handshake.
func TestNoSessionBeforeHandshakeCompletes(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, _, _, _ := configs(t, prologue)

	h, err := NewHandshake(initCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Session(); !errors.Is(err, ErrHandshakeIncomplete) {
		t.Fatalf("got %v, want ErrHandshakeIncomplete", err)
	}
	if _, err := h.PeerStatic(); !errors.Is(err, ErrPeerKeyUnavailable) {
		t.Fatalf("got %v, want ErrPeerKeyUnavailable", err)
	}
}

// TestOutOfTurnOperationsRejected catches protocol misuse directly rather
// than letting it surface as an opaque cryptographic error.
func TestOutOfTurnOperationsRejected(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, _, _ := configs(t, prologue)

	initiator, err := NewHandshake(initCfg)
	if err != nil {
		t.Fatal(err)
	}
	responder, err := NewHandshake(respCfg)
	if err != nil {
		t.Fatal(err)
	}

	// The initiator moves first, so reading first is out of turn.
	if _, err := initiator.ReadMessage([]byte("whatever")); !errors.Is(err, ErrWrongTurn) {
		t.Fatalf("initiator read first: got %v, want ErrWrongTurn", err)
	}
	// The responder must not speak before it has read.
	if _, err := responder.WriteMessage(nil); !errors.Is(err, ErrWrongTurn) {
		t.Fatalf("responder wrote first: got %v, want ErrWrongTurn", err)
	}
}

// TestTamperedCiphertextFails confirms the AEAD rejects modified traffic
// rather than returning altered plaintext.
func TestTamperedCiphertextFails(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, _, _ := configs(t, prologue)
	client, daemon, err := pair(t, initCfg, respCfg)
	if err != nil {
		t.Fatal(err)
	}

	sealed, err := client.Encrypt([]byte("approve everything"))
	if err != nil {
		t.Fatal(err)
	}
	sealed[0] ^= 0xff
	if _, err := daemon.Decrypt(sealed); err == nil {
		t.Fatal("tampered ciphertext was accepted")
	}
}

// TestReplayedMessageFails covers replay within a live session: Noise nonces
// advance, so the same ciphertext cannot be delivered twice.
func TestReplayedMessageFails(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, _, _ := configs(t, prologue)
	client, daemon, err := pair(t, initCfg, respCfg)
	if err != nil {
		t.Fatal(err)
	}

	sealed, err := client.Encrypt([]byte("task.start"))
	if err != nil {
		t.Fatal(err)
	}
	replay := bytes.Clone(sealed)

	if _, err := daemon.Decrypt(sealed); err != nil {
		t.Fatal(err)
	}
	if _, err := daemon.Decrypt(replay); err == nil {
		t.Fatal("a replayed message was accepted a second time")
	}
}

// TestSessionsFromDifferentHandshakesAreIncompatible covers the rule that a
// reconnect starts a fresh handshake: traffic from one session must not
// decrypt in another.
func TestSessionsFromDifferentHandshakesAreIncompatible(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))

	initCfg, respCfg, phone, device := configs(t, prologue)
	clientA, _, err := pair(t, initCfg, respCfg)
	if err != nil {
		t.Fatal(err)
	}

	// Same peers, new handshake, as happens after a reconnect.
	initCfg2 := Config{Initiator: true, StaticKey: phone, Prologue: prologue, VerifyPeer: acceptAll}
	respCfg2 := Config{Initiator: false, StaticKey: device, Prologue: prologue, VerifyPeer: acceptAll}
	_, daemonB, err := pair(t, initCfg2, respCfg2)
	if err != nil {
		t.Fatal(err)
	}

	sealed, err := clientA.Encrypt([]byte("from the old session"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := daemonB.Decrypt(sealed); err == nil {
		t.Fatal("a message from a previous session decrypted in a new one")
	}
}

func TestEncryptRejectsOversizedMessage(t *testing.T) {
	prologue := DevicePrologue([]byte("device-id-bytes"))
	initCfg, respCfg, _, _ := configs(t, prologue)
	client, _, err := pair(t, initCfg, respCfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Encrypt(make([]byte, MaxMessageSize+1)); err == nil {
		t.Fatal("oversized message was accepted")
	}
	if _, err := client.Encrypt(make([]byte, MaxMessageSize)); err != nil {
		t.Fatalf("message at the limit was rejected: %v", err)
	}
}

func TestNewHandshakeRequiresConfiguration(t *testing.T) {
	if _, err := NewHandshake(Config{Initiator: true, VerifyPeer: acceptAll}); err == nil {
		t.Fatal("handshake created without a static key")
	}
	// A missing VerifyPeer must be an error, not a silent accept-all.
	if _, err := NewHandshake(Config{Initiator: true, StaticKey: newStatic(t)}); err == nil {
		t.Fatal("handshake created without a peer verification callback")
	}
}

func TestDevicePrologueMatchesProtocol(t *testing.T) {
	id := []byte("device-id-bytes")
	want := protocol.NoisePrologue(protocol.Version, protocol.RoleClient, protocol.RoleDevice, id)
	if !bytes.Equal(DevicePrologue(id), want) {
		t.Fatal("DevicePrologue disagrees with protocol.NoisePrologue")
	}
}
