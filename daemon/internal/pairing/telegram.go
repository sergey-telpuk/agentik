package pairing

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// TelegramProductionEd25519KeyHex is Telegram's documented Ed25519 public key
// for third-party Mini App initData verification (without a Bot Token).
const TelegramProductionEd25519KeyHex = "e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d"

// MaxInitDataLength bounds raw initData strings accepted from the wire.
const MaxInitDataLength = 8192

var (
	// ErrInvalidInitData is returned when raw initData is malformed or missing
	// required fields.
	ErrInvalidInitData = errors.New("pairing: invalid telegram initData")
	// ErrBadInitDataSignature is returned when the Ed25519 signature fails.
	ErrBadInitDataSignature = errors.New("pairing: telegram initData signature verification failed")
	// ErrStaleInitData is returned when auth_date is expired or unreasonably far
	// in the future.
	ErrStaleInitData = errors.New("pairing: telegram initData is stale")
	// ErrTelegramNotConfigured is returned when Telegram bot_id is not
	// configured on the daemon.
	ErrTelegramNotConfigured = errors.New("pairing: telegram verification is not configured (missing bot_id)")
)

// TelegramIdentity represents a cryptographically verified Telegram Mini App
// launch identity.
type TelegramIdentity struct {
	UserID    int64
	Username  string
	FirstName string
	AuthDate  time.Time
}

// DefaultTelegramPublicKey returns Telegram's production Ed25519 verification key.
func DefaultTelegramPublicKey() ed25519.PublicKey {
	b, err := hex.DecodeString(TelegramProductionEd25519KeyHex)
	if err != nil {
		panic(err)
	}
	return ed25519.PublicKey(b)
}

// VerifyInitData validates raw Telegram Mini App initData using Telegram's
// third-party Ed25519 verification scheme (AGENTIK.md section 5.4).
//
// It verifies format, signature over `<bot_id>:WebAppData\n<sorted k=v>`,
// and auth_date freshness before reading user metadata.
func VerifyInitData(
	rawInitData string,
	expectedBotID int64,
	maxAge time.Duration,
	now time.Time,
	pubKey ed25519.PublicKey,
) (*TelegramIdentity, error) {
	if expectedBotID <= 0 {
		return nil, ErrTelegramNotConfigured
	}
	if len(pubKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%w: invalid verifier public key size", ErrInvalidInitData)
	}
	if rawInitData == "" || len(rawInitData) > MaxInitDataLength {
		return nil, fmt.Errorf("%w: empty or oversized initData", ErrInvalidInitData)
	}

	values, err := url.ParseQuery(rawInitData)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidInitData, err)
	}

	sigText := values.Get("signature")
	if sigText == "" {
		return nil, fmt.Errorf("%w: missing signature", ErrInvalidInitData)
	}
	sig, err := decodeExactBase64URL(sigText, ed25519.SignatureSize)
	if err != nil {
		return nil, fmt.Errorf("%w: signature: %v", ErrInvalidInitData, err)
	}

	authDateText := values.Get("auth_date")
	if authDateText == "" {
		return nil, fmt.Errorf("%w: missing auth_date", ErrInvalidInitData)
	}
	authUnix, err := strconv.ParseInt(authDateText, 10, 64)
	if err != nil || authUnix <= 0 {
		return nil, fmt.Errorf("%w: invalid auth_date", ErrInvalidInitData)
	}

	keys := make([]string, 0, len(values))
	for k := range values {
		if k == "hash" || k == "signature" {
			continue
		}
		if len(values[k]) != 1 {
			return nil, fmt.Errorf("%w: duplicate parameter %q", ErrInvalidInitData, k)
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)

	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+"="+values.Get(k))
	}
	dataCheckString := fmt.Sprintf("%d:WebAppData\n%s", expectedBotID, strings.Join(lines, "\n"))

	if !ed25519.Verify(pubKey, []byte(dataCheckString), sig) {
		return nil, ErrBadInitDataSignature
	}

	authDate := time.Unix(authUnix, 0)
	if authDate.After(now.Add(protocol.MaxClockSkew)) {
		return nil, fmt.Errorf("%w: auth_date is in the future", ErrStaleInitData)
	}
	if maxAge > 0 && now.Sub(authDate) > maxAge {
		return nil, fmt.Errorf("%w: auth_date expired", ErrStaleInitData)
	}

	userRaw := values.Get("user")
	if userRaw == "" {
		return nil, fmt.Errorf("%w: missing user field", ErrInvalidInitData)
	}
	var user struct {
		ID        int64  `json:"id"`
		Username  string `json:"username"`
		FirstName string `json:"first_name"`
	}
	if err := json.Unmarshal([]byte(userRaw), &user); err != nil || user.ID <= 0 {
		return nil, fmt.Errorf("%w: invalid user JSON", ErrInvalidInitData)
	}

	return &TelegramIdentity{
		UserID:    user.ID,
		Username:  user.Username,
		FirstName: user.FirstName,
		AuthDate:  authDate,
	}, nil
}

// SignInitDataTest builds a signed initData query string for tests.
func SignInitDataTest(botID int64, userID int64, username string, authDate time.Time, priv ed25519.PrivateKey) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", errors.New("invalid ed25519 private key")
	}
	userJSON, err := json.Marshal(map[string]any{
		"id":         userID,
		"username":   username,
		"first_name": username,
	})
	if err != nil {
		return "", err
	}
	params := url.Values{}
	params.Set("auth_date", strconv.FormatInt(authDate.Unix(), 10))
	params.Set("user", string(userJSON))

	keys := []string{"auth_date", "user"}
	sort.Strings(keys)
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+"="+params.Get(k))
	}
	dataCheckString := fmt.Sprintf("%d:WebAppData\n%s", botID, strings.Join(lines, "\n"))
	sig := ed25519.Sign(priv, []byte(dataCheckString))
	params.Set("signature", base64.RawURLEncoding.EncodeToString(sig))
	return params.Encode(), nil
}
