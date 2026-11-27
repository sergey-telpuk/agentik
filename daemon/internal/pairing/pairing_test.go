package pairing

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

func newTestEnv(t *testing.T, opts ...func(*Config)) (*Service, *identity.Identity, *storage.DB, *time.Time) {
	t.Helper()
	ctx := context.Background()
	db, err := storage.Open(ctx, storage.InMemory)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	id, err := identity.Generate()
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}

	now := time.Unix(1_764_259_200, 0).UTC()
	cfg := Config{
		DB:       db,
		Identity: id,
		Now:      func() time.Time { return now },
	}
	for _, opt := range opts {
		opt(&cfg)
	}
	svc, err := NewService(cfg)
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	return svc, id, db, &now
}

func newPhoneKey(t *testing.T) []byte {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("x25519: %v", err)
	}
	return k.PublicKey().Bytes()
}

func TestCreateAndParseInvitationRoundTrip(t *testing.T) {
	svc, id, db, now := newTestEnv(t)
	ctx := context.Background()

	issued, err := svc.CreateInvitation(ctx, "wss://agentik-relay.agentikcl.workers.dev/", 5*time.Minute)
	if err != nil {
		t.Fatalf("CreateInvitation: %v", err)
	}
	if !strings.HasPrefix(issued.InvitationText, InvitationPrefix) {
		t.Fatalf("invitation text missing prefix: %q", issued.InvitationText)
	}
	if issued.QR == "" || !strings.ContainsRune(issued.QR, '█') {
		t.Fatalf("QR code output unexpected: %q", issued.QR)
	}

	parsed, err := ParseInvitation(issued.InvitationText, *now)
	if err != nil {
		t.Fatalf("ParseInvitation: %v", err)
	}
	if !bytes.Equal(parsed.Descriptor.NoisePublicKey, id.NoisePublicKey()) {
		t.Fatal("parsed noise key mismatch")
	}
	if parsed.DeviceIDText != id.DeviceIDString() {
		t.Fatalf("device id text = %s, want %s", parsed.DeviceIDText, id.DeviceIDString())
	}

	// Also ensure SQLite stored only the SHA-256 hash of the secret, never the secret.
	var storedHash []byte
	var state string
	err = db.SQL().QueryRowContext(ctx,
		`SELECT secret_hash, state FROM pairing_invitations WHERE id = ?`,
		issued.ID,
	).Scan(&storedHash, &state)
	if err != nil {
		t.Fatalf("query pairing_invitations: %v", err)
	}
	wantHash := sha256.Sum256(parsed.InvitationSecret)
	if !bytes.Equal(storedHash, wantHash[:]) {
		t.Fatal("stored hash does not match SHA-256(secret)")
	}
	if bytes.Equal(storedHash, parsed.InvitationSecret) {
		t.Fatal("secret stored unhashed")
	}
	if state != "pending" {
		t.Fatalf("state = %q, want pending", state)
	}
}

func TestPairingFullFlowWithLocalConfirmation(t *testing.T) {
	svc, id, db, _ := newTestEnv(t)
	ctx := context.Background()
	phoneKey := newPhoneKey(t)

	// Before any invitation, no active invitations exist and unknown phones are rejected.
	active, err := svc.HasActiveInvitation(ctx)
	if err != nil || active {
		t.Fatalf("HasActiveInvitation = %v, %v; want false, nil", active, err)
	}
	if _, err := svc.VerifyTrustedClient(ctx, phoneKey); !errors.Is(err, ErrUnknownClient) {
		t.Fatalf("VerifyTrustedClient before pairing: got %v, want ErrUnknownClient", err)
	}

	issued, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	active, err = svc.HasActiveInvitation(ctx)
	if err != nil || !active {
		t.Fatalf("HasActiveInvitation = %v, %v; want true, nil", active, err)
	}

	parsed, err := ParseInvitation(issued.InvitationText, time.Unix(1_764_259_200, 0))
	if err != nil {
		t.Fatal(err)
	}

	pending, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phoneKey,
		PinnedDeviceNoiseKey: id.NoisePublicKey(),
		InvitationSecret:     parsed.InvitationSecret,
		Label:                "My Phone",
	})
	if err != nil {
		t.Fatalf("SubmitPairing: %v", err)
	}

	// Crucial invariant: awaiting local approval does NOT grant access yet.
	if _, err := svc.VerifyTrustedClient(ctx, phoneKey); !errors.Is(err, ErrUnknownClient) {
		t.Fatalf("phone gained trust before local confirmation: %v", err)
	}
	if got := svc.ListPending(); len(got) != 1 || got[0].ID != pending.ID {
		t.Fatalf("ListPending = %+v", got)
	}

	trusted, err := svc.ConfirmPairing(ctx, pending.ID, "Sergey iPhone")
	if err != nil {
		t.Fatalf("ConfirmPairing: %v", err)
	}
	if trusted.Label != "Sergey iPhone" {
		t.Fatalf("label = %q, want Sergey iPhone", trusted.Label)
	}

	// Phone is now persisted as trusted in SQLite.
	verified, err := svc.VerifyTrustedClient(ctx, phoneKey)
	if err != nil {
		t.Fatalf("VerifyTrustedClient after confirm: %v", err)
	}
	if !bytes.Equal(verified.NoisePublicKey, phoneKey) {
		t.Fatal("verified key mismatch")
	}

	// Invitation must be marked consumed and no longer active.
	var invState string
	if err := db.SQL().QueryRowContext(ctx, `SELECT state FROM pairing_invitations WHERE id = ?`, issued.ID).Scan(&invState); err != nil {
		t.Fatal(err)
	}
	if invState != "consumed" {
		t.Fatalf("invitation state = %q, want consumed", invState)
	}
}

func TestPairingRejectsUnknownPhone(t *testing.T) {
	svc, id, _, _ := newTestEnv(t)
	ctx := context.Background()

	issued, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseInvitation(issued.InvitationText, time.Unix(1_764_259_200, 0))
	if err != nil {
		t.Fatal(err)
	}

	// Wrong secret must be rejected.
	badSecret := make([]byte, InvitationSecretSize)
	badSecret[0] = 0x42
	unknownPhone := newPhoneKey(t)
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: unknownPhone,
		InvitationSecret:     badSecret,
	}); !errors.Is(err, ErrInvalidInvitation) {
		t.Fatalf("wrong secret: got %v, want ErrInvalidInvitation", err)
	}

	// Pair phone A; phone B must still be rejected as unknown.
	phoneA := newPhoneKey(t)
	phoneB := newPhoneKey(t)
	pending, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phoneA,
		PinnedDeviceNoiseKey: id.NoisePublicKey(),
		InvitationSecret:     parsed.InvitationSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmPairing(ctx, pending.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyTrustedClient(ctx, phoneB); !errors.Is(err, ErrUnknownClient) {
		t.Fatalf("phone B verify: got %v, want ErrUnknownClient", err)
	}
}

func TestPairingRejectsExpiredInvitation(t *testing.T) {
	svc, id, db, now := newTestEnv(t)
	ctx := context.Background()

	issued, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 1*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseInvitation(issued.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}

	// Advance clock past expiry before parsing.
	if _, err := ParseInvitation(issued.InvitationText, now.Add(2*time.Minute)); !errors.Is(err, protocol.ErrExpired) {
		t.Fatalf("ParseInvitation expired: got %v, want ErrExpired", err)
	}

	// Advance clock past expiry before submitting.
	*now = now.Add(2 * time.Minute)
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: newPhoneKey(t),
		PinnedDeviceNoiseKey: id.NoisePublicKey(),
		InvitationSecret:     parsed.InvitationSecret,
	}); !errors.Is(err, ErrInvitationExpired) {
		t.Fatalf("SubmitPairing expired: got %v, want ErrInvitationExpired", err)
	}

	// Verify expired invitation cannot grant trust.
	var state string
	if err := db.SQL().QueryRowContext(ctx, `SELECT state FROM pairing_invitations WHERE id = ?`, issued.ID).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "expired" {
		t.Fatalf("state = %q, want expired", state)
	}

	// Also check expiry between SubmitPairing and ConfirmPairing.
	issued2, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 1*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed2, err := ParseInvitation(issued2.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}
	phone2 := newPhoneKey(t)
	pending2, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone2,
		InvitationSecret:     parsed2.InvitationSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	*now = now.Add(2 * time.Minute)
	if _, err := svc.ConfirmPairing(ctx, pending2.ID, ""); !errors.Is(err, ErrInvitationExpired) {
		t.Fatalf("ConfirmPairing after expiry: got %v, want ErrInvitationExpired", err)
	}
	if _, err := svc.VerifyTrustedClient(ctx, phone2); !errors.Is(err, ErrUnknownClient) {
		t.Fatalf("expired confirm granted trust: %v", err)
	}
}

func TestPairingRejectsReplayedInvitation(t *testing.T) {
	svc, _, _, now := newTestEnv(t)
	ctx := context.Background()

	issued, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseInvitation(issued.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}

	phone1 := newPhoneKey(t)
	phone2 := newPhoneKey(t)
	pending, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone1,
		InvitationSecret:     parsed.InvitationSecret,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Concurrent replay while awaiting confirmation must fail.
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone2,
		InvitationSecret:     parsed.InvitationSecret,
	}); !errors.Is(err, ErrInvitationReplayed) {
		t.Fatalf("concurrent replay: got %v, want ErrInvitationReplayed", err)
	}

	// Confirm phone1, then replay with phone2 -> rejected.
	if _, err := svc.ConfirmPairing(ctx, pending.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone2,
		InvitationSecret:     parsed.InvitationSecret,
	}); !errors.Is(err, ErrInvitationReplayed) {
		t.Fatalf("post-confirm replay: got %v, want ErrInvitationReplayed", err)
	}

	// Rejected invitation cannot be replayed either.
	issued2, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed2, err := ParseInvitation(issued2.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}
	pending2, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone2,
		InvitationSecret:     parsed2.InvitationSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RejectPairing(ctx, pending2.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: newPhoneKey(t),
		InvitationSecret:     parsed2.InvitationSecret,
	}); !errors.Is(err, ErrInvitationRejected) {
		t.Fatalf("post-reject replay: got %v, want ErrInvitationRejected", err)
	}
}

func TestPairingRejectsPinSubstitution(t *testing.T) {
	svc, _, _, now := newTestEnv(t)
	ctx := context.Background()

	issued, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	// 1. Tamper NoisePublicKey in wire payload without the registration key.
	rawJSON, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(issued.InvitationText, InvitationPrefix))
	if err != nil {
		t.Fatal(err)
	}
	var wire InvitationWire
	if err := json.Unmarshal(rawJSON, &wire); err != nil {
		t.Fatal(err)
	}
	attackerNoiseKey := newPhoneKey(t)
	wire.NoisePublicKey = base64.RawURLEncoding.EncodeToString(attackerNoiseKey)
	tamperedJSON, _ := json.Marshal(wire)
	tamperedText := InvitationPrefix + base64.RawURLEncoding.EncodeToString(tamperedJSON)

	if _, err := ParseInvitation(tamperedText, *now); !errors.Is(err, protocol.ErrSignature) {
		t.Fatalf("tampered invitation noise key: got %v, want ErrSignature", err)
	}

	// 2. Phone presents a different pinned computer Noise key during submission.
	parsed, err := ParseInvitation(issued.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: newPhoneKey(t),
		PinnedDeviceNoiseKey: attackerNoiseKey,
		InvitationSecret:     parsed.InvitationSecret,
	}); !errors.Is(err, ErrPinMismatch) {
		t.Fatalf("SubmitPairing pin substitution: got %v, want ErrPinMismatch", err)
	}
}

func TestRevocationEndsAccessAndBlocksRepair(t *testing.T) {
	svc, _, _, now := newTestEnv(t)
	ctx := context.Background()

	issued, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseInvitation(issued.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}

	phone := newPhoneKey(t)
	pending, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone,
		InvitationSecret:     parsed.InvitationSecret,
	})
	if err != nil {
		t.Fatal(err)
	}
	trusted, err := svc.ConfirmPairing(ctx, pending.ID, "phone")
	if err != nil {
		t.Fatal(err)
	}

	if err := svc.RevokeClient(ctx, trusted.ID); err != nil {
		t.Fatalf("RevokeClient: %v", err)
	}
	if _, err := svc.VerifyTrustedClient(ctx, phone); !errors.Is(err, ErrClientRevoked) {
		t.Fatalf("VerifyTrustedClient after revoke: got %v, want ErrClientRevoked", err)
	}
	revoked, err := svc.IsRevoked(ctx, phone)
	if err != nil || !revoked {
		t.Fatalf("IsRevoked = %v, %v", revoked, err)
	}

	// Revoked phone cannot re-pair even with a fresh invitation.
	issued2, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed2, err := ParseInvitation(issued2.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone,
		InvitationSecret:     parsed2.InvitationSecret,
	}); !errors.Is(err, ErrClientRevoked) {
		t.Fatalf("SubmitPairing with revoked phone: got %v, want ErrClientRevoked", err)
	}
}

func TestTelegramInitDataVerification(t *testing.T) {
	tgPub, tgPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const botID = int64(987654321)
	svc, _, _, now := newTestEnv(t, func(cfg *Config) {
		cfg.TelegramBotID = botID
		cfg.TelegramPublicKey = tgPub
		cfg.InitDataMaxAge = 10 * time.Minute
	})
	ctx := context.Background()

	validInit, err := SignInitDataTest(botID, 4242, "sergey", now.Add(-1*time.Minute), tgPriv)
	if err != nil {
		t.Fatal(err)
	}
	forgedInit := strings.Replace(validInit, "4242", "9999", 1)
	staleInit, err := SignInitDataTest(botID, 4242, "sergey", now.Add(-20*time.Minute), tgPriv)
	if err != nil {
		t.Fatal(err)
	}
	wrongBotInit, err := SignInitDataTest(111111, 4242, "sergey", now.Add(-1*time.Minute), tgPriv)
	if err != nil {
		t.Fatal(err)
	}

	issued, err := svc.CreateInvitation(ctx, "wss://relay.example.com", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseInvitation(issued.InvitationText, *now)
	if err != nil {
		t.Fatal(err)
	}

	// Forged initData rejected.
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: newPhoneKey(t),
		InvitationSecret:     parsed.InvitationSecret,
		InitData:             forgedInit,
	}); !errors.Is(err, ErrBadInitDataSignature) {
		t.Fatalf("forged initData: got %v, want ErrBadInitDataSignature", err)
	}

	// Wrong bot_id rejected.
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: newPhoneKey(t),
		InvitationSecret:     parsed.InvitationSecret,
		InitData:             wrongBotInit,
	}); !errors.Is(err, ErrBadInitDataSignature) {
		t.Fatalf("wrong bot_id: got %v, want ErrBadInitDataSignature", err)
	}

	// Stale initData rejected.
	if _, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: newPhoneKey(t),
		InvitationSecret:     parsed.InvitationSecret,
		InitData:             staleInit,
	}); !errors.Is(err, ErrStaleInitData) {
		t.Fatalf("stale initData: got %v, want ErrStaleInitData", err)
	}

	// Valid initData succeeds and binds TelegramUserID.
	phone := newPhoneKey(t)
	pending, err := svc.SubmitPairing(ctx, SubmitRequest{
		ClientNoisePublicKey: phone,
		InvitationSecret:     parsed.InvitationSecret,
		InitData:             validInit,
	})
	if err != nil {
		t.Fatalf("valid initData SubmitPairing: %v", err)
	}
	if pending.TelegramUserID != 4242 || pending.TelegramUsername != "sergey" {
		t.Fatalf("pending telegram identity = %+v", pending)
	}
	trusted, err := svc.ConfirmPairing(ctx, pending.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if trusted.TelegramUserID != 4242 {
		t.Fatalf("trusted telegram user id = %d, want 4242", trusted.TelegramUserID)
	}
	if _, err := svc.VerifyTelegramSession(ctx, trusted.ID, validInit); err != nil {
		t.Fatalf("VerifyTelegramSession valid: %v", err)
	}

	// Different Telegram user presenting valid signature for different account must be rejected.
	otherUserInit, err := SignInitDataTest(botID, 7777, "other", now.Add(-1*time.Minute), tgPriv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.VerifyTelegramSession(ctx, trusted.ID, otherUserInit); !errors.Is(err, ErrBadInitDataSignature) {
		t.Fatalf("mismatched telegram user: got %v", err)
	}
}
