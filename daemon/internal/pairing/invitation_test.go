package pairing

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/sergey-telpuk/agentik/daemon/internal/identity"
	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

// decodeInvitationBytes returns the binary payload of an invitation text.
func decodeInvitationBytes(t *testing.T, text string) []byte {
	t.Helper()
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.TrimPrefix(text, InvitationPrefix))
	if err != nil {
		t.Fatalf("decode invitation: %v", err)
	}
	return raw
}

func encodeInvitationBytes(raw []byte) string {
	return InvitationPrefix + base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
}

// invitationVector is the cross-language invitation vector. The same text and
// fields are asserted by miniapp/src/pairing/invitation.test.ts: the Mini App
// parses and verifies what this daemon prints, so a change to the binary
// layout or the signed descriptor on either side fails both suites.
//
// Inputs: register Ed25519 seed bytes 0x00..0x1f, Noise scalar bytes
// 0x20..0x3f, invitation secret bytes 0x40..0x5f, expiry 1900000000. Ed25519
// signatures are deterministic, so the text is reproducible. Regenerate only
// together with a deliberate invitation version change.
var invitationVectors = []struct {
	name           string
	relayURL       string
	deviceIDText   string
	registerKeyB64 string // standard base64
	noiseKeyB64    string // standard base64
	payloadSize    int    // bytes of the binary payload
	text           string
}{
	{
		name:           "default relay",
		relayURL:       DefaultRelayURL,
		deviceIDText:   "kzdvvj2umnduyauf35o36k6kw462mujvra46tn3uqgzovmihocga",
		registerKeyB64: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
		noiseKeyB64:    "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=",
		payloadSize:    166,
		text: "AGENTIK1:AEAAHIIHX7Z44EF6DVYN2GHHJPAJSZ7E2YYJXJINL4O5ZBTECJKTDOBVQBZNMNSYQDI252RSTLPZCIJYHBI62INCRY" +
			"5XL2LF2DJM2FTCKRAECQSDIRCUMR2IJFFEWTCNJZHVAUKSKNKFKVSXLBMVUW24LVPF64J7WMAJVZBXFZ5ZPH3CJLUQULYL2QR63ZNG" +
			"2PRWNIDFCHZDWIEGUGZSCXOHDEEHU7J32GD37D4GU367HD552QBXBI5GX52AHLLG2NCFZQDFBQ",
	},
	{
		name:           "custom wss relay",
		relayURL:       "wss://relay.example.com/base",
		deviceIDText:   "kzdvvj2umnduyauf35o36k6kw462mujvra46tn3uqgzovmihocga",
		registerKeyB64: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
		noiseKeyB64:    "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=",
		payloadSize:    188,
		text: "AGENTIK1:AEAQHIIHX7Z44EF6DVYN2GHHJPAJSZ7E2YYJXJINL4O5ZBTECJKTDOBVQBZNMNSYQDI252RSTLPZCIJYHBI62INCRY" +
			"5XL2LF2DJM2FTCKRAECQSDIRCUMR2IJFFEWTCNJZHVAUKSKNKFKVSXLBMVUW24LVPF64J7WMAKB5QDSDDS5UJ3CUBDZ5PZFKIVM2GD" +
			"VV7R57U6J3SGG5ZQVS5TYMW2VMUPNHQI5GRYYUMGGM2NWQ5542PTGLQX525BU6Z4PJRPBT7RBFZGK3DBPEXGK6DBNVYGYZJOMNXW2L3CMFZWK",
	},
}

const vectorExpiry int64 = 1_900_000_000

func seq(start byte, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = start + byte(i)
	}
	return b
}

func buildVector(t *testing.T, relayURL string) (string, *protocol.PairingDescriptor, []byte) {
	t.Helper()
	id, err := identity.FromSeeds(seq(0x00, 32), seq(0x20, 32))
	if err != nil {
		t.Fatal(err)
	}
	secret := seq(0x40, 32)
	sum := sha256.Sum256(secret)
	desc := &protocol.PairingDescriptor{
		Version:           protocol.Version,
		RelayURL:          relayURL,
		DeviceID:          id.DeviceID(),
		RegisterPublicKey: id.RegisterPublicKey(),
		NoisePublicKey:    id.NoisePublicKey(),
		InvitationHash:    sum[:],
		ExpiresAt:         time.Unix(vectorExpiry, 0),
	}
	if err := desc.Sign(id.RegisterPrivateKey()); err != nil {
		t.Fatal(err)
	}
	text, err := EncodeInvitation(desc, secret)
	if err != nil {
		t.Fatal(err)
	}
	return text, desc, secret
}

func TestInvitationCrossLanguageVector(t *testing.T) {
	for i := range invitationVectors {
		v := invitationVectors[i]
		t.Run(v.name, func(t *testing.T) {
			text, desc, _ := buildVector(t, v.relayURL)
			b64 := base64.StdEncoding.EncodeToString
			if v.text == "" {
				t.Fatalf("vector not recorded yet:\ntext=%s\ndevice=%s\nregister=%s\nnoise=%s\nsize=%d",
					text, protocol.FormatDeviceID(desc.DeviceID), b64(desc.RegisterPublicKey),
					b64(desc.NoisePublicKey), len(decodeInvitationBytes(t, text)))
			}
			if text != v.text {
				t.Fatalf("invitation text changed:\n got %s\nwant %s", text, v.text)
			}
			if got := protocol.FormatDeviceID(desc.DeviceID); got != v.deviceIDText {
				t.Fatalf("device id text = %s, want %s", got, v.deviceIDText)
			}
			if got := b64(desc.RegisterPublicKey); got != v.registerKeyB64 {
				t.Fatalf("register key = %s, want %s", got, v.registerKeyB64)
			}
			if got := b64(desc.NoisePublicKey); got != v.noiseKeyB64 {
				t.Fatalf("noise key = %s, want %s", got, v.noiseKeyB64)
			}
			if got := len(decodeInvitationBytes(t, text)); got != v.payloadSize {
				t.Fatalf("binary payload is %d bytes, want %d", got, v.payloadSize)
			}
			parsed, err := ParseInvitation(v.text, time.Unix(vectorExpiry-60, 0))
			if err != nil {
				t.Fatalf("parse vector: %v", err)
			}
			if parsed.Descriptor.RelayURL != v.relayURL {
				t.Fatalf("relay = %s, want %s", parsed.Descriptor.RelayURL, v.relayURL)
			}
		})
	}
}

func TestInvitationEncodeParseRoundTrip(t *testing.T) {
	for _, relay := range []string{
		DefaultRelayURL,
		"wss://relay.example.com",
		"wss://relay.example.com:8443/base",
		"ws://127.0.0.1:8787",
		"ws://localhost:8787",
	} {
		t.Run(relay, func(t *testing.T) {
			text, desc, secret := buildVector(t, relay)
			parsed, err := ParseInvitation(text, time.Unix(vectorExpiry-60, 0))
			if err != nil {
				t.Fatalf("ParseInvitation: %v", err)
			}
			got := parsed.Descriptor
			if got.Version != desc.Version || got.RelayURL != desc.RelayURL ||
				!ed25519.PublicKey(got.RegisterPublicKey).Equal(desc.RegisterPublicKey) ||
				!protocol.ConstantTimeEqual(got.DeviceID, desc.DeviceID) ||
				!protocol.ConstantTimeEqual(got.NoisePublicKey, desc.NoisePublicKey) ||
				!protocol.ConstantTimeEqual(got.InvitationHash, desc.InvitationHash) ||
				!got.ExpiresAt.Equal(desc.ExpiresAt) ||
				!protocol.ConstantTimeEqual(got.Signature, desc.Signature) ||
				!protocol.ConstantTimeEqual(parsed.InvitationSecret, secret) {
				t.Fatalf("round trip changed the descriptor: %+v", got)
			}
			if parsed.DeviceIDText != protocol.FormatDeviceID(desc.DeviceID) {
				t.Fatalf("device id text = %s", parsed.DeviceIDText)
			}
		})
	}
}

func TestInvitationSizeAndQRVersion(t *testing.T) {
	// The default relay and a custom relay of up to 22 bytes after the scheme
	// fit QR version 10 at level M; longer custom relays grow the code.
	for _, relay := range []string{
		DefaultRelayURL,
		"wss://relay.example.com",
		"wss://relay.example.co/abcde", // 22 bytes after the scheme
	} {
		text, _, _ := buildVector(t, relay)
		raw := decodeInvitationBytes(t, text)
		version, err := QRVersion(text)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("relay %s: %d bytes binary, %d chars text, QR version %d at level M\n%s",
			relay, len(raw), len(text), version, text)
		if version > 10 {
			t.Errorf("relay %s: QR version %d, want <= 10", relay, version)
		}
		if len(raw) > 270 {
			t.Errorf("relay %s: %d binary bytes, want <= 270", relay, len(raw))
		}
	}
	if len(decodeInvitationBytes(t, mustVectorText(t, DefaultRelayURL))) != invitationFixedSize {
		t.Fatalf("default relay invitation should be exactly %d bytes", invitationFixedSize)
	}
	if version, _ := QRVersion(mustVectorText(t, "wss://relay.example.co/abcdef")); version != 11 {
		t.Fatalf("a 23-byte custom relay should need QR version 11, got %d", version)
	}
}

// TestPrintRealInvitation issues an invitation through the service, the way
// the daemon does on startup, and logs what would be printed with its size.
func TestPrintRealInvitation(t *testing.T) {
	svc, _, _, _ := newTestEnv(t, func(c *Config) { c.Now = time.Now })
	inv, err := svc.CreateInvitation(t.Context(), DefaultRelayURL, 10*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	version, err := QRVersion(inv.InvitationText)
	if err != nil {
		t.Fatal(err)
	}
	art, err := renderQR(inv.InvitationText, false)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(art, "\n"), "\n")
	width := utf8.RuneCountInString(lines[0])
	t.Logf("%d bytes binary, %d chars text, QR version %d at level M, %d columns x %d lines\n%s\n%s",
		len(decodeInvitationBytes(t, inv.InvitationText)), len(inv.InvitationText), version, width, len(lines),
		art, inv.InvitationText)
	if version > 10 || width > 80 {
		t.Fatalf("QR version %d, width %d", version, width)
	}
	if _, err := ParseInvitation(inv.InvitationText, time.Now()); err != nil {
		t.Fatalf("issued invitation does not parse: %v", err)
	}
}

func mustVectorText(t *testing.T, relay string) string {
	t.Helper()
	text, _, _ := buildVector(t, relay)
	return text
}

var ansiSGR = regexp.MustCompile("\x1b\\[[0-9;]*m")

func TestRenderQRFitsTerminal(t *testing.T) {
	text := mustVectorText(t, DefaultRelayURL)
	version, err := QRVersion(text)
	if err != nil {
		t.Fatal(err)
	}
	modules := 17 + 4*version + 2*QRQuietZone
	for _, color := range []bool{true, false} {
		art, err := renderQR(text, color)
		if err != nil {
			t.Fatal(err)
		}
		lines := strings.Split(strings.TrimSuffix(art, "\n"), "\n")
		if want := (modules + 1) / 2; len(lines) != want {
			t.Errorf("color=%v: %d lines, want %d (half-block, two module rows per line)", color, len(lines), want)
		}
		for i, line := range lines {
			if w := utf8.RuneCountInString(ansiSGR.ReplaceAllString(line, "")); w != modules || w > 80 {
				t.Fatalf("color=%v line %d is %d columns, want %d and <= 80", color, i, w, modules)
			}
		}
		t.Logf("color=%v: %d columns x %d lines, QR version %d", color, modules, len(lines), version)
	}
}

func TestParseInvitationToleratesTerminalFormatting(t *testing.T) {
	text := mustVectorText(t, DefaultRelayURL)
	now := time.Unix(vectorExpiry-60, 0)
	wrapped := "  " + text[:70] + "\n" + text[70:140] + " \r\n\t" + strings.ToLower(text[140:]) + "\n"
	if _, err := ParseInvitation(wrapped, now); err != nil {
		t.Fatalf("wrapped, lowercased invitation: %v", err)
	}
}

func TestParseInvitationRejectsTamperedInput(t *testing.T) {
	text := mustVectorText(t, "wss://relay.example.com")
	now := time.Unix(vectorExpiry-60, 0)
	raw := decodeInvitationBytes(t, text)

	// Every byte of the payload is covered by either the signature, the
	// derived identifiers, or a structural check: flipping any one is fatal.
	for i := range raw {
		mutated := append([]byte(nil), raw...)
		mutated[i] ^= 0x01
		if _, err := ParseInvitation(encodeInvitationBytes(mutated), now); err == nil {
			t.Fatalf("flipping byte %d was accepted", i)
		}
	}

	cases := map[string]string{
		"empty":           "",
		"no prefix":       strings.TrimPrefix(text, InvitationPrefix),
		"old json format": `{"v":1,"relay":"wss://relay.example.com"}`,
		"bad base32":      InvitationPrefix + "!!!!",
		"truncated":       encodeInvitationBytes(raw[:invitationFixedSize-1]),
		"oversized":       InvitationPrefix + strings.Repeat("A", MaxInvitationTextLength),
	}
	for name, in := range cases {
		if _, err := ParseInvitation(in, now); !errors.Is(err, protocol.ErrMalformed) {
			t.Errorf("%s: got %v, want ErrMalformed", name, err)
		}
	}

	// Signature-specific failures surface as ErrSignature.
	sigFlip := append([]byte(nil), raw...)
	sigFlip[2+32+32+32+4] ^= 0xff
	if _, err := ParseInvitation(encodeInvitationBytes(sigFlip), now); !errors.Is(err, protocol.ErrSignature) {
		t.Errorf("signature flip: got %v, want ErrSignature", err)
	}
	// Changing the relay or expiry is detected because both are signed.
	expFlip := append([]byte(nil), raw...)
	expFlip[2+32+32+32+3] ^= 0x01
	if _, err := ParseInvitation(encodeInvitationBytes(expFlip), now); !errors.Is(err, protocol.ErrSignature) {
		t.Errorf("expiry flip: got %v, want ErrSignature", err)
	}
}

func TestParseInvitationRejectsExpired(t *testing.T) {
	text := mustVectorText(t, DefaultRelayURL)
	if _, err := ParseInvitation(text, time.Unix(vectorExpiry, 0)); !errors.Is(err, protocol.ErrExpired) {
		t.Fatalf("at expiry: got %v, want ErrExpired", err)
	}
	if _, err := ParseInvitation(text, time.Unix(vectorExpiry+1, 0)); !errors.Is(err, protocol.ErrExpired) {
		t.Fatalf("after expiry: got %v, want ErrExpired", err)
	}
}

func TestEncodeInvitationRejectsUnrepresentable(t *testing.T) {
	_, desc, secret := buildVector(t, DefaultRelayURL)
	late := *desc
	late.ExpiresAt = time.Unix(1<<32, 0)
	if _, err := EncodeInvitation(&late, secret); err == nil {
		t.Fatal("expiry beyond 32 bits was encoded")
	}
	if _, err := EncodeInvitation(desc, secret[:31]); err == nil {
		t.Fatal("short secret was encoded")
	}
	other := *desc
	other.RelayURL = "ws://relay.example.com" // not loopback
	if _, err := EncodeInvitation(&other, secret); err == nil {
		t.Fatal("plain ws relay on a non-loopback host was encoded")
	}
	other.RelayURL = "wss://relay.example.com/" // signed form differs from what the phone rebuilds
	if _, err := EncodeInvitation(&other, secret); err == nil {
		t.Fatal("a relay URL that is not normalised was encoded")
	}
}

func TestParseInvitationRejectsSpelledOutDefaultRelay(t *testing.T) {
	text := mustVectorText(t, DefaultRelayURL)
	raw := decodeInvitationBytes(t, text)
	raw[1] = relayWSS
	raw = append(raw, strings.TrimPrefix(DefaultRelayURL, "wss://")...)
	if _, err := ParseInvitation(encodeInvitationBytes(raw), time.Unix(vectorExpiry-60, 0)); !errors.Is(err, protocol.ErrMalformed) {
		t.Fatalf("default relay as a custom relay: got %v, want ErrMalformed", err)
	}
}

func TestPairedClientCount(t *testing.T) {
	svc, _, db, _ := newTestEnv(t)
	ctx := t.Context()
	count, err := svc.PairedClientCount(ctx)
	if err != nil || count != 0 {
		t.Fatalf("empty database: count=%d err=%v", count, err)
	}
	if _, err := db.SQL().ExecContext(ctx,
		`INSERT INTO trusted_clients (noise_public_key, telegram_user_id, paired_at, revoked_at) VALUES (?, 1, 1, 2)`,
		seq(1, 32)); err != nil {
		t.Fatal(err)
	}
	if count, _ = svc.PairedClientCount(ctx); count != 0 {
		t.Fatalf("a revoked client counts as paired: count=%d", count)
	}
	for i := range 2 {
		if _, err := db.SQL().ExecContext(ctx,
			`INSERT INTO trusted_clients (noise_public_key, telegram_user_id, paired_at) VALUES (?, 1, 1)`,
			seq(byte(2+i), 32)); err != nil {
			t.Fatal(err)
		}
	}
	if count, _ = svc.PairedClientCount(ctx); count != 2 {
		t.Fatalf("active clients: count=%d, want 2", count)
	}
}
