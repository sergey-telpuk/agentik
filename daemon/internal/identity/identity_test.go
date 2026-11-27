package identity

import (
	"bytes"
	"crypto/ed25519"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/sergey-telpuk/agentik/daemon/internal/protocol"
)

func TestGenerateProducesDistinctKeys(t *testing.T) {
	id, err := Generate()
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if len(id.RegisterPublicKey()) != ed25519.PublicKeySize {
		t.Fatalf("registration key is %d bytes", len(id.RegisterPublicKey()))
	}
	if len(id.NoisePublicKey()) != protocol.NoiseKeySize {
		t.Fatalf("noise key is %d bytes", len(id.NoisePublicKey()))
	}
	// The two identities serve different roles and must never coincide.
	if bytes.Equal(id.RegisterPublicKey(), id.NoisePublicKey()) {
		t.Fatal("registration and noise keys are identical")
	}

	other, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(id.DeviceID(), other.DeviceID()) {
		t.Fatal("two generated identities share a device id")
	}
}

func TestDeviceIDDerivedFromRegistrationKey(t *testing.T) {
	id, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	want := protocol.DeviceIDFromKey(id.RegisterPublicKey())
	if !bytes.Equal(id.DeviceID(), want) {
		t.Fatal("device id is not SHA-256 of the registration key")
	}
	if id.DeviceIDString() != protocol.FormatDeviceID(want) {
		t.Fatal("string device id disagrees with raw device id")
	}
}

// TestDeviceIDIsACopy guards the accessor against a caller mutating internal
// state, which would silently change the device's address.
func TestDeviceIDIsACopy(t *testing.T) {
	id, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	got := id.DeviceID()
	got[0] ^= 0xff
	if bytes.Equal(id.DeviceID(), got) {
		t.Fatal("DeviceID returned a slice aliasing internal state")
	}
}

func TestSeedsRoundTrip(t *testing.T) {
	id, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	registerSeed, noiseScalar := id.Seeds()
	restored, err := FromSeeds(registerSeed, noiseScalar)
	if err != nil {
		t.Fatalf("FromSeeds: %v", err)
	}
	if !restored.RegisterPublicKey().Equal(id.RegisterPublicKey()) {
		t.Fatal("registration key did not round trip")
	}
	if !bytes.Equal(restored.NoisePublicKey(), id.NoisePublicKey()) {
		t.Fatal("noise key did not round trip")
	}
	if !bytes.Equal(restored.DeviceID(), id.DeviceID()) {
		t.Fatal("device id did not round trip")
	}
}

func TestFromSeedsRejectsBadMaterial(t *testing.T) {
	good, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	seed, scalar := good.Seeds()

	if _, err := FromSeeds(seed[:16], scalar); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("short seed: got %v, want ErrInvalidKey", err)
	}
	if _, err := FromSeeds(seed, scalar[:16]); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("short scalar: got %v, want ErrInvalidKey", err)
	}
}

func TestStoreLoadOrCreateIsStable(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	first, created, err := store.LoadOrCreate()
	if err != nil {
		t.Fatalf("first LoadOrCreate: %v", err)
	}
	if !created {
		t.Fatal("first run should report a created identity")
	}

	second, created, err := store.LoadOrCreate()
	if err != nil {
		t.Fatalf("second LoadOrCreate: %v", err)
	}
	if created {
		t.Fatal("second run must reuse the stored identity, not create one")
	}
	if !bytes.Equal(first.DeviceID(), second.DeviceID()) {
		t.Fatal("device id changed across restarts")
	}
}

func TestLoadReportsNotFound(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v, want ErrNotFound", err)
	}
}

// TestSavedKeyFileIsOwnerOnly checks the one protection this file-backed
// fallback actually provides.
func TestSavedKeyFileIsOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits are not meaningful on Windows")
	}
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.LoadOrCreate(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(dir, "identity.json"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != keyFileMode {
		t.Fatalf("key file mode is %o, want %o", perm, keyFileMode)
	}
}

// TestSaveLeavesNoTemporaryFiles ensures an atomic write does not litter the
// data directory with key material under a temporary name.
func TestSaveLeavesNoTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	id, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err := store.Save(id); err != nil {
			t.Fatalf("Save: %v", err)
		}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if len(names) != 1 || names[0] != "identity.json" {
		t.Fatalf("data directory holds %v, want only identity.json", names)
	}
}

func TestSaveOverwritesExistingIdentity(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	first, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(first); err != nil {
		t.Fatal(err)
	}
	second, err := Generate()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(second); err != nil {
		t.Fatal(err)
	}

	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(loaded.DeviceID(), second.DeviceID()) {
		t.Fatal("Save did not replace the previous identity")
	}
}

func TestLoadRejectsCorruptFile(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "identity.json"), []byte("{not json"), keyFileMode); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); err == nil {
		t.Fatal("corrupt key file was accepted")
	}
}

func TestLoadRejectsUnknownVersion(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	body := []byte(`{"version":99,"backend":"file","register_seed":"","noise_scalar":""}`)
	if err := os.WriteFile(filepath.Join(dir, "identity.json"), body, keyFileMode); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Load(); err == nil {
		t.Fatal("unknown key file version was accepted")
	}
}

func TestNewStoreDefaultsToPlatformDir(t *testing.T) {
	store, err := NewStore("")
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if store.Dir() == "" {
		t.Fatal("default store directory is empty")
	}
	if !filepath.IsAbs(store.Dir()) {
		t.Fatalf("default store directory %q is not absolute", store.Dir())
	}
}

// TestSaveCreatesOwnerOnlyDirectory checks that the data directory itself is
// not readable by other local accounts.
func TestSaveCreatesOwnerOnlyDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits are not meaningful on Windows")
	}
	base := t.TempDir()
	dir := filepath.Join(base, "nested", "agentik")
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.LoadOrCreate(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != dirMode {
		t.Fatalf("data directory mode is %o, want %o", perm, dirMode)
	}
	var _ fs.FileMode = dirMode
}

func TestDefaultDirPerPlatform(t *testing.T) {
	home := func() (string, error) { return filepath.Join("home", "me"), nil }
	cfg := func() (string, error) { return filepath.Join("cfg"), nil }
	failing := func() (string, error) { return "", errors.New("unset") }

	cases := []struct {
		goos string
		want string
	}{
		// macOS keeps its existing location so stored data is not orphaned.
		{"darwin", filepath.Join("home", "me", "Library", "Application Support", "Agentik")},
		{"windows", filepath.Join("cfg", "Agentik")},
		{"linux", filepath.Join("cfg", "agentik")},
	}
	for _, c := range cases {
		got, err := defaultDirFor(c.goos, home, cfg)
		if err != nil || got != c.want {
			t.Errorf("%s: got %q, %v; want %q", c.goos, got, err, c.want)
		}
	}
	if _, err := defaultDirFor("darwin", failing, cfg); err == nil {
		t.Error("darwin: missing home directory must be an error")
	}
	if _, err := defaultDirFor("windows", home, failing); err == nil {
		t.Error("windows: missing config directory must be an error")
	}
}
