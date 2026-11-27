package pairing

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
	"github.com/sergey-telpuk/agentik/daemon/internal/storage"
)

var (
	// ErrUnknownClient is returned when a phone's Noise static key is not paired.
	ErrUnknownClient = errors.New("pairing: unknown phone")
	// ErrClientRevoked is returned when a previously paired phone was revoked.
	ErrClientRevoked = errors.New("pairing: phone access was revoked")
	// ErrAlreadyPaired is returned when an already paired phone submits an invitation.
	ErrAlreadyPaired = errors.New("pairing: phone is already paired")
	// ErrInvalidInvitation is returned when an invitation secret is unknown or malformed.
	ErrInvalidInvitation = errors.New("pairing: invalid invitation")
	// ErrInvitationExpired is returned when an invitation is past its TTL.
	ErrInvitationExpired = errors.New("pairing: invitation expired")
	// ErrInvitationReplayed is returned when an invitation has already been used or claimed.
	ErrInvitationReplayed = errors.New("pairing: invitation already consumed")
	// ErrInvitationRejected is returned when an invitation was rejected locally.
	ErrInvitationRejected = errors.New("pairing: invitation was rejected")
	// ErrPinMismatch is returned when the peer's pinned computer key differs from this device.
	ErrPinMismatch = errors.New("pairing: pinned computer Noise key mismatch")
	// ErrPendingNotFound is returned when confirming/rejecting an unknown pending pairing.
	ErrPendingNotFound = errors.New("pairing: pending confirmation not found")
)

const (
	defaultInvitationAttempts = 5
	defaultInitDataMaxAge     = 1 * time.Hour
)

// IssuedInvitation is returned on the computer when generating a pairing QR/text.
// InvitationText carries the one-time secret for display; the secret itself is
// never written to SQLite.
type IssuedInvitation struct {
	ID             string
	ExpiresAt      time.Time
	InvitationText string
	QR             string
	Descriptor     *protocol.PairingDescriptor
}

// SubmitRequest arrives over an authenticated Noise XX handshake from a phone
// attempting to pair with this computer.
type SubmitRequest struct {
	// ClientNoisePublicKey must come strictly from the completed Noise session's PeerStatic().
	ClientNoisePublicKey []byte
	// PinnedDeviceNoiseKey optionally commits to the computer key the phone pinned from QR.
	PinnedDeviceNoiseKey []byte
	InvitationSecret     []byte
	InitData             string
	Label                string
}

// PendingConfirmation represents a pairing request awaiting explicit confirmation
// by the user on the computer (AGENTIK.md section 5.3).
type PendingConfirmation struct {
	ID                   string
	InvitationID         string
	ClientNoisePublicKey []byte
	Fingerprint          string
	TelegramUserID       int64
	TelegramUsername     string
	Label                string
	CreatedAt            time.Time
	ExpiresAt            time.Time
}

// TrustedClient is a paired phone persisted in SQLite.
type TrustedClient struct {
	ID             int64
	NoisePublicKey []byte
	Fingerprint    string
	TelegramUserID int64
	Label          string
	PairedAt       time.Time
	RevokedAt      *time.Time
}

// Config configures the pairing Service.
type Config struct {
	DB                *storage.DB
	Identity          *identity.Identity
	TelegramBotID     int64
	TelegramPublicKey ed25519.PublicKey
	InitDataMaxAge    time.Duration
	Now               func() time.Time
	OnPendingChange   func()
}

// Service manages invitations, local confirmation, trusted clients, and revocation.
type Service struct {
	db       *storage.DB
	identity *identity.Identity
	botID    int64
	tgPub    ed25519.PublicKey
	tgMaxAge time.Duration
	now      func() time.Time
	onChange func()

	mu      sync.Mutex
	pending map[string]*PendingConfirmation
	// byInvitationID tracks active in-flight claims so an invitation cannot be
	// claimed concurrently before local confirmation finishes.
	byInvitationID map[string]string
}

// NewService constructs a pairing Service backed by SQLite.
func NewService(cfg Config) (*Service, error) {
	if cfg.DB == nil {
		return nil, errors.New("pairing: database is required")
	}
	if cfg.Identity == nil {
		return nil, errors.New("pairing: device identity is required")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	tgPub := cfg.TelegramPublicKey
	if len(tgPub) == 0 {
		tgPub = DefaultTelegramPublicKey()
	}
	maxAge := cfg.InitDataMaxAge
	if maxAge <= 0 {
		maxAge = defaultInitDataMaxAge
	}
	return &Service{
		db:             cfg.DB,
		identity:       cfg.Identity,
		botID:          cfg.TelegramBotID,
		tgPub:          tgPub,
		tgMaxAge:       maxAge,
		now:            cfg.Now,
		onChange:       cfg.OnPendingChange,
		pending:        make(map[string]*PendingConfirmation),
		byInvitationID: make(map[string]string),
	}, nil
}

// CreateInvitation generates a single-use pairing invitation with TTL, stores
// only the SHA-256 hash of its secret in SQLite, signs the PairingDescriptor,
// and returns the text/QR payload for display on the computer.
func (s *Service) CreateInvitation(ctx context.Context, relayURL string, ttl time.Duration) (*IssuedInvitation, error) {
	if ttl <= 0 {
		return nil, errors.New("pairing: invitation TTL must be positive")
	}
	normalizedRelay, err := NormalizeRelayURL(relayURL)
	if err != nil {
		return nil, err
	}

	secret := make([]byte, InvitationSecretSize)
	if _, err := rand.Read(secret); err != nil {
		return nil, fmt.Errorf("pairing: generate invitation secret: %w", err)
	}
	secretHash := sha256.Sum256(secret)
	invID, err := randomHexID(16)
	if err != nil {
		return nil, err
	}

	now := s.now().UTC()
	expiresAt := now.Add(ttl)

	desc := &protocol.PairingDescriptor{
		Version:           protocol.Version,
		RelayURL:          normalizedRelay,
		DeviceID:          s.identity.DeviceID(),
		RegisterPublicKey: s.identity.RegisterPublicKey(),
		NoisePublicKey:    s.identity.NoisePublicKey(),
		InvitationHash:    secretHash[:],
		ExpiresAt:         expiresAt,
	}
	if err := desc.Sign(s.identity.RegisterPrivateKey()); err != nil {
		return nil, fmt.Errorf("pairing: sign pairing descriptor: %w", err)
	}

	encoded, err := EncodeInvitation(desc, secret)
	if err != nil {
		return nil, err
	}
	qrText, err := RenderQR(encoded)
	if err != nil {
		return nil, err
	}

	if _, err := s.db.SQL().ExecContext(ctx,
		`INSERT INTO pairing_invitations (id, secret_hash, state, attempts, created_at, expires_at)
		 VALUES (?, ?, 'pending', 0, ?, ?)`,
		invID, secretHash[:], now.Unix(), expiresAt.Unix(),
	); err != nil {
		return nil, fmt.Errorf("pairing: store invitation: %w", err)
	}

	return &IssuedInvitation{
		ID:             invID,
		ExpiresAt:      expiresAt,
		InvitationText: encoded,
		QR:             qrText,
		Descriptor:     desc,
	}, nil
}

// HasActiveInvitation reports whether at least one unconsumed, unexpired
// pairing invitation currently exists. Expired rows are swept to 'expired'.
func (s *Service) HasActiveInvitation(ctx context.Context) (bool, error) {
	nowUnix := s.now().Unix()
	if _, err := s.db.SQL().ExecContext(ctx,
		`UPDATE pairing_invitations SET state = 'expired'
		 WHERE state = 'pending' AND expires_at <= ?`,
		nowUnix,
	); err != nil {
		return false, fmt.Errorf("pairing: sweep expired invitations: %w", err)
	}

	var count int
	if err := s.db.SQL().QueryRowContext(ctx,
		`SELECT COUNT(1) FROM pairing_invitations WHERE state = 'pending' AND expires_at > ?`,
		nowUnix,
	).Scan(&count); err != nil {
		return false, fmt.Errorf("pairing: check active invitations: %w", err)
	}
	return count > 0, nil
}

// SubmitPairing validates a pairing submission from a phone over a completed
// Noise XX handshake and queues it for local confirmation on the computer.
//
// The client key is NOT added to trusted_clients until ConfirmPairing is called.
func (s *Service) SubmitPairing(ctx context.Context, req SubmitRequest) (*PendingConfirmation, error) {
	if len(req.ClientNoisePublicKey) != protocol.NoiseKeySize {
		return nil, fmt.Errorf("%w: invalid client Noise key size", protocol.ErrMalformed)
	}
	if len(req.PinnedDeviceNoiseKey) > 0 && !protocol.ConstantTimeEqual(req.PinnedDeviceNoiseKey, s.identity.NoisePublicKey()) {
		return nil, ErrPinMismatch
	}
	if len(req.InvitationSecret) != InvitationSecretSize {
		return nil, ErrInvalidInvitation
	}

	// Reject revoked or already-paired keys before touching invitations.
	switch existing, err := s.lookupClient(ctx, req.ClientNoisePublicKey); {
	case err == nil && existing.RevokedAt != nil:
		return nil, ErrClientRevoked
	case err == nil:
		return nil, ErrAlreadyPaired
	case !errors.Is(err, ErrUnknownClient):
		return nil, err
	}

	now := s.now()
	var tgUserID int64
	var tgUsername string
	if s.botID > 0 {
		tgID, err := VerifyInitData(req.InitData, s.botID, s.tgMaxAge, now, s.tgPub)
		if err != nil {
			return nil, err
		}
		tgUserID = tgID.UserID
		tgUsername = tgID.Username
	}

	secretHash := sha256.Sum256(req.InvitationSecret)

	var invID string
	var state string
	var attempts int
	var expiresAtUnix int64
	err := s.db.SQL().QueryRowContext(ctx,
		`SELECT id, state, attempts, expires_at FROM pairing_invitations WHERE secret_hash = ?`,
		secretHash[:],
	).Scan(&invID, &state, &attempts, &expiresAtUnix)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrInvalidInvitation
	}
	if err != nil {
		return nil, fmt.Errorf("pairing: load invitation: %w", err)
	}

	switch state {
	case "consumed":
		return nil, ErrInvitationReplayed
	case "rejected":
		return nil, ErrInvitationRejected
	case "expired":
		return nil, ErrInvitationExpired
	case "pending":
	default:
		return nil, ErrInvalidInvitation
	}

	if now.Unix() >= expiresAtUnix {
		_, _ = s.db.SQL().ExecContext(ctx,
			`UPDATE pairing_invitations SET state = 'expired' WHERE id = ? AND state = 'pending'`,
			invID,
		)
		return nil, ErrInvitationExpired
	}

	if attempts >= defaultInvitationAttempts {
		_, _ = s.db.SQL().ExecContext(ctx,
			`UPDATE pairing_invitations SET state = 'rejected' WHERE id = ? AND state = 'pending'`,
			invID,
		)
		return nil, ErrInvitationRejected
	}

	if _, err := s.db.SQL().ExecContext(ctx,
		`UPDATE pairing_invitations SET attempts = attempts + 1 WHERE id = ? AND state = 'pending'`,
		invID,
	); err != nil {
		return nil, fmt.Errorf("pairing: update invitation attempts: %w", err)
	}

	pendingID, err := randomHexID(16)
	if err != nil {
		return nil, err
	}
	label := strings.TrimSpace(req.Label)
	if len(label) > 64 {
		label = label[:64]
	}

	entry := &PendingConfirmation{
		ID:                   pendingID,
		InvitationID:         invID,
		ClientNoisePublicKey: append([]byte(nil), req.ClientNoisePublicKey...),
		Fingerprint:          Fingerprint(req.ClientNoisePublicKey),
		TelegramUserID:       tgUserID,
		TelegramUsername:     tgUsername,
		Label:                label,
		CreatedAt:            now,
		ExpiresAt:            time.Unix(expiresAtUnix, 0),
	}

	s.mu.Lock()
	if _, exists := s.byInvitationID[invID]; exists {
		s.mu.Unlock()
		return nil, ErrInvitationReplayed
	}
	s.byInvitationID[invID] = pendingID
	s.pending[pendingID] = entry
	s.mu.Unlock()

	if s.onChange != nil {
		s.onChange()
	}

	cp := *entry
	cp.ClientNoisePublicKey = append([]byte(nil), entry.ClientNoisePublicKey...)
	return &cp, nil
}

// ListPending returns all non-expired pending local confirmations.
func (s *Service) ListPending() []PendingConfirmation {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]PendingConfirmation, 0, len(s.pending))
	for id, p := range s.pending {
		if now.Unix() >= p.ExpiresAt.Unix() {
			delete(s.pending, id)
			delete(s.byInvitationID, p.InvitationID)
			continue
		}
		cp := *p
		cp.ClientNoisePublicKey = append([]byte(nil), p.ClientNoisePublicKey...)
		out = append(out, cp)
	}
	return out
}

// ConfirmPairing completes local confirmation on the computer for a specific
// pending pairing, atomically consuming the one-time invitation and persisting
// the phone's Noise static public key in trusted_clients.
func (s *Service) ConfirmPairing(ctx context.Context, pendingID string, labelOverride string) (*TrustedClient, error) {
	s.mu.Lock()
	entry, ok := s.pending[pendingID]
	if ok {
		delete(s.pending, pendingID)
		delete(s.byInvitationID, entry.InvitationID)
	}
	s.mu.Unlock()
	if !ok {
		return nil, ErrPendingNotFound
	}

	now := s.now()
	if now.Unix() >= entry.ExpiresAt.Unix() {
		_, _ = s.db.SQL().ExecContext(ctx,
			`UPDATE pairing_invitations SET state = 'expired' WHERE id = ? AND state = 'pending'`,
			entry.InvitationID,
		)
		return nil, ErrInvitationExpired
	}

	label := entry.Label
	if strings.TrimSpace(labelOverride) != "" {
		label = strings.TrimSpace(labelOverride)
	}
	if len(label) > 64 {
		label = label[:64]
	}

	tx, err := s.db.SQL().BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("pairing: begin confirmation tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	res, err := tx.ExecContext(ctx,
		`UPDATE pairing_invitations
		 SET state = 'consumed', consumed_at = ?
		 WHERE id = ? AND state = 'pending' AND expires_at > ?`,
		now.Unix(), entry.InvitationID, now.Unix(),
	)
	if err != nil {
		return nil, fmt.Errorf("pairing: consume invitation: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("pairing: check consumed rows: %w", err)
	}
	if affected != 1 {
		return nil, ErrInvitationReplayed
	}

	// Guard against confirming a key that was inserted/revoked concurrently.
	var existingID int64
	var revoked sql.NullInt64
	err = tx.QueryRowContext(ctx,
		`SELECT id, revoked_at FROM trusted_clients WHERE noise_public_key = ?`,
		entry.ClientNoisePublicKey,
	).Scan(&existingID, &revoked)
	if err == nil {
		if revoked.Valid {
			return nil, ErrClientRevoked
		}
		return nil, ErrAlreadyPaired
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("pairing: check existing client: %w", err)
	}

	insertRes, err := tx.ExecContext(ctx,
		`INSERT INTO trusted_clients (noise_public_key, telegram_user_id, label, paired_at)
		 VALUES (?, ?, ?, ?)`,
		entry.ClientNoisePublicKey, entry.TelegramUserID, label, now.Unix(),
	)
	if err != nil {
		return nil, fmt.Errorf("pairing: persist trusted client: %w", err)
	}
	clientID, err := insertRes.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("pairing: read inserted client id: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("pairing: commit confirmation: %w", err)
	}
	if s.onChange != nil {
		s.onChange()
	}

	return &TrustedClient{
		ID:             clientID,
		NoisePublicKey: append([]byte(nil), entry.ClientNoisePublicKey...),
		Fingerprint:    entry.Fingerprint,
		TelegramUserID: entry.TelegramUserID,
		Label:          label,
		PairedAt:       now,
	}, nil
}

// RejectPairing declines a pending pairing on the computer and marks its
// invitation rejected so it cannot be replayed.
func (s *Service) RejectPairing(ctx context.Context, pendingID string) error {
	s.mu.Lock()
	entry, ok := s.pending[pendingID]
	if ok {
		delete(s.pending, pendingID)
		delete(s.byInvitationID, entry.InvitationID)
	}
	s.mu.Unlock()
	if !ok {
		return ErrPendingNotFound
	}

	if _, err := s.db.SQL().ExecContext(ctx,
		`UPDATE pairing_invitations SET state = 'rejected' WHERE id = ? AND state = 'pending'`,
		entry.InvitationID,
	); err != nil {
		return fmt.Errorf("pairing: reject invitation: %w", err)
	}
	if s.onChange != nil {
		s.onChange()
	}
	return nil
}

// VerifyTrustedClient confirms that noisePub belongs to a paired, non-revoked
// phone. Used both during the Noise handshake and before handling commands.
func (s *Service) VerifyTrustedClient(ctx context.Context, noisePub []byte) (*TrustedClient, error) {
	if len(noisePub) != protocol.NoiseKeySize {
		return nil, ErrUnknownClient
	}
	c, err := s.lookupClient(ctx, noisePub)
	if err != nil {
		return nil, err
	}
	if c.RevokedAt != nil {
		return nil, ErrClientRevoked
	}
	return c, nil
}

// IsRevoked reports whether noisePub has an explicit revoked record in SQLite.
func (s *Service) IsRevoked(ctx context.Context, noisePub []byte) (bool, error) {
	if len(noisePub) != protocol.NoiseKeySize {
		return false, nil
	}
	c, err := s.lookupClient(ctx, noisePub)
	if errors.Is(err, ErrUnknownClient) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return c.RevokedAt != nil, nil
}

func (s *Service) lookupClient(ctx context.Context, noisePub []byte) (*TrustedClient, error) {
	var c TrustedClient
	var pairedUnix int64
	var revokedUnix sql.NullInt64
	err := s.db.SQL().QueryRowContext(ctx,
		`SELECT id, noise_public_key, telegram_user_id, label, paired_at, revoked_at
		 FROM trusted_clients WHERE noise_public_key = ?`,
		noisePub,
	).Scan(&c.ID, &c.NoisePublicKey, &c.TelegramUserID, &c.Label, &pairedUnix, &revokedUnix)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownClient
	}
	if err != nil {
		return nil, fmt.Errorf("pairing: lookup client: %w", err)
	}
	c.Fingerprint = Fingerprint(c.NoisePublicKey)
	c.PairedAt = time.Unix(pairedUnix, 0)
	if revokedUnix.Valid {
		t := time.Unix(revokedUnix.Int64, 0)
		c.RevokedAt = &t
	}
	return &c, nil
}

// ListTrustedClients returns all paired phones ordered by pairing time.
func (s *Service) ListTrustedClients(ctx context.Context) ([]TrustedClient, error) {
	rows, err := s.db.SQL().QueryContext(ctx,
		`SELECT id, noise_public_key, telegram_user_id, label, paired_at, revoked_at
		 FROM trusted_clients ORDER BY id ASC`,
	)
	if err != nil {
		return nil, fmt.Errorf("pairing: list trusted clients: %w", err)
	}
	defer rows.Close()

	var out []TrustedClient
	for rows.Next() {
		var c TrustedClient
		var pairedUnix int64
		var revokedUnix sql.NullInt64
		if err := rows.Scan(&c.ID, &c.NoisePublicKey, &c.TelegramUserID, &c.Label, &pairedUnix, &revokedUnix); err != nil {
			return nil, fmt.Errorf("pairing: scan trusted client: %w", err)
		}
		c.Fingerprint = Fingerprint(c.NoisePublicKey)
		c.PairedAt = time.Unix(pairedUnix, 0)
		if revokedUnix.Valid {
			t := time.Unix(revokedUnix.Int64, 0)
			c.RevokedAt = &t
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// RevokeClient marks a trusted client revoked by its SQLite row ID.
func (s *Service) RevokeClient(ctx context.Context, clientID int64) error {
	res, err := s.db.SQL().ExecContext(ctx,
		`UPDATE trusted_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
		s.now().Unix(), clientID,
	)
	if err != nil {
		return fmt.Errorf("pairing: revoke client: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrUnknownClient
	}
	return nil
}

// RevokeByKey marks a trusted client revoked by its Noise static public key.
func (s *Service) RevokeByKey(ctx context.Context, noisePub []byte) error {
	res, err := s.db.SQL().ExecContext(ctx,
		`UPDATE trusted_clients SET revoked_at = ? WHERE noise_public_key = ? AND revoked_at IS NULL`,
		s.now().Unix(), noisePub,
	)
	if err != nil {
		return fmt.Errorf("pairing: revoke client by key: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrUnknownClient
	}
	return nil
}

// VerifyTelegramSession validates raw Telegram initData on an already-paired
// connection, confirming both the Ed25519 signature/freshness and that the
// Telegram user matches the paired client (if bound).
func (s *Service) VerifyTelegramSession(ctx context.Context, clientID int64, rawInitData string) (*TelegramIdentity, error) {
	if s.botID <= 0 {
		return nil, ErrTelegramNotConfigured
	}
	tgID, err := VerifyInitData(rawInitData, s.botID, s.tgMaxAge, s.now(), s.tgPub)
	if err != nil {
		return nil, err
	}
	var boundUserID int64
	var revoked sql.NullInt64
	err = s.db.SQL().QueryRowContext(ctx,
		`SELECT telegram_user_id, revoked_at FROM trusted_clients WHERE id = ?`,
		clientID,
	).Scan(&boundUserID, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrUnknownClient
	}
	if err != nil {
		return nil, fmt.Errorf("pairing: lookup client for telegram verification: %w", err)
	}
	if revoked.Valid {
		return nil, ErrClientRevoked
	}
	if boundUserID != 0 && boundUserID != tgID.UserID {
		return nil, fmt.Errorf("%w: telegram user mismatch", ErrBadInitDataSignature)
	}
	return tgID, nil
}

func randomHexID(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("pairing: random id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
