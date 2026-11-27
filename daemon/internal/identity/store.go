package identity

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
)

// ErrNotFound is returned by Load when no identity has been stored yet.
var ErrNotFound = errors.New("identity: no stored identity")

// keyFileMode is the permission for the private key file: owner read/write
// only. The daemon runs with ordinary user privileges, so the file system is
// the boundary that keeps other local accounts out.
const keyFileMode fs.FileMode = 0o600

// dirMode is the permission for the data directory: owner access only.
const dirMode fs.FileMode = 0o700

// storedIdentity is the on-disk representation of the private material.
//
// This file is the fallback used where no OS secure store is wired up. The
// design document requires that any such fallback be explicit rather than
// silent, so Store records which backend wrote the file.
type storedIdentity struct {
	// Version allows the format to change without misreading old files.
	Version int `json:"version"`
	// Backend names where the material actually lives, so an operator can
	// tell a file-backed key from one held in an OS store.
	Backend string `json:"backend"`
	// RegisterSeed is the 32-byte Ed25519 seed.
	RegisterSeed []byte `json:"register_seed"`
	// NoiseScalar is the 32-byte X25519 private scalar.
	NoiseScalar []byte `json:"noise_scalar"`
}

// BackendFile marks an identity stored as a permission-restricted file.
const BackendFile = "file"

// Store persists a device identity.
//
// The current implementation is file-backed with owner-only permissions. An
// OS keychain backend is a separate, platform-specific piece of work; until
// it exists, this backend is named explicitly in the stored file rather than
// being presented as secure-store protection.
type Store struct {
	dir string
}

// NewStore returns a Store rooted at dir.
//
// Passing an empty dir uses the platform data directory for Agentik.
func NewStore(dir string) (*Store, error) {
	if dir == "" {
		d, err := DefaultDir()
		if err != nil {
			return nil, err
		}
		dir = d
	}
	return &Store{dir: dir}, nil
}

// Dir returns the directory the store writes to.
func (s *Store) Dir() string { return s.dir }

// path returns the key file location.
func (s *Store) path() string { return filepath.Join(s.dir, "identity.json") }

// DefaultDir returns the per-user data directory for Agentik state.
//
// A single stable location is used so that history and keys do not end up in
// a process working directory that changes between launches.
func DefaultDir() (string, error) {
	if runtime.GOOS == "darwin" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("identity: locate home directory: %w", err)
		}
		return filepath.Join(home, "Library", "Application Support", "Agentik"), nil
	}
	// On Linux this honours XDG_CONFIG_HOME; on Windows it is %AppData%.
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("identity: locate config directory: %w", err)
	}
	return filepath.Join(base, "agentik"), nil
}

// Load reads the stored identity.
//
// It returns ErrNotFound when nothing has been stored, which the caller is
// expected to treat as "first run" rather than as a failure.
func (s *Store) Load() (*Identity, error) {
	raw, err := os.ReadFile(s.path())
	if errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("identity: read key file: %w", err)
	}
	var stored storedIdentity
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("identity: parse key file: %w", err)
	}
	if stored.Version != 1 {
		return nil, fmt.Errorf("identity: key file version %d is not supported", stored.Version)
	}
	id, err := FromSeeds(stored.RegisterSeed, stored.NoiseScalar)
	if err != nil {
		return nil, err
	}
	return id, nil
}

// Save writes the identity's private material with owner-only permissions.
//
// The write is atomic: the material goes to a temporary file in the same
// directory and is renamed into place, so an interrupted write cannot leave a
// half-written key file that would lock the user out of their own device
// identity.
func (s *Store) Save(id *Identity) error {
	if err := os.MkdirAll(s.dir, dirMode); err != nil {
		return fmt.Errorf("identity: create data directory: %w", err)
	}
	registerSeed, noiseScalar := id.Seeds()
	payload, err := json.Marshal(storedIdentity{
		Version:      1,
		Backend:      BackendFile,
		RegisterSeed: registerSeed,
		NoiseScalar:  noiseScalar,
	})
	if err != nil {
		return fmt.Errorf("identity: encode key file: %w", err)
	}

	tmp, err := os.CreateTemp(s.dir, ".identity-*.tmp")
	if err != nil {
		return fmt.Errorf("identity: create temporary key file: %w", err)
	}
	tmpName := tmp.Name()
	// Remove the temporary file on any path that does not rename it away.
	defer func() { _ = os.Remove(tmpName) }()

	// Set permissions before writing, so the secret is never briefly
	// readable by other accounts. CreateTemp already uses 0600, but an
	// explicit Chmod keeps that guarantee independent of its behaviour.
	if err := tmp.Chmod(keyFileMode); err != nil {
		tmp.Close()
		return fmt.Errorf("identity: set key file permissions: %w", err)
	}
	if _, err := tmp.Write(payload); err != nil {
		tmp.Close()
		return fmt.Errorf("identity: write key file: %w", err)
	}
	// Flush to disk before the rename, so a crash cannot leave a renamed
	// file with no contents.
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("identity: sync key file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("identity: close key file: %w", err)
	}
	if err := os.Rename(tmpName, s.path()); err != nil {
		return fmt.Errorf("identity: install key file: %w", err)
	}
	return nil
}

// LoadOrCreate returns the stored identity, generating and saving one on
// first run.
//
// created reports whether a new identity was generated, so the caller can
// tell a first run from a restart without inspecting the file system.
func (s *Store) LoadOrCreate() (id *Identity, created bool, err error) {
	id, err = s.Load()
	switch {
	case err == nil:
		return id, false, nil
	case errors.Is(err, ErrNotFound):
		id, err = Generate()
		if err != nil {
			return nil, false, err
		}
		if err := s.Save(id); err != nil {
			return nil, false, err
		}
		return id, true, nil
	default:
		return nil, false, err
	}
}
