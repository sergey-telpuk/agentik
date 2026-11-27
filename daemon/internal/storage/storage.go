// Package storage opens the daemon's SQLite database and keeps its schema up
// to date.
//
// This database is the source of truth for what the Mini App displays: tasks,
// events, approvals, and pairings. The relay holds none of it. Private key
// material is not stored here — see the identity package.
package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite" // pure-Go driver: no cgo, so cross-builds stay self-contained
)

// driverName is the database/sql driver registered by modernc.org/sqlite.
const driverName = "sqlite"

// dbFileMode keeps the database readable only by its owner: it holds task
// history and prompts.
const dbFileMode = 0o600

// migration is one ordered, irreversible schema step.
type migration struct {
	version int
	name    string
	stmts   []string
}

// DB wraps the SQLite handle used by the daemon.
type DB struct {
	sql  *sql.DB
	path string
}

// Open opens the database at path, creating it and applying any pending
// migrations.
//
// Passing ":memory:" opens a private in-memory database, which is what tests
// use.
func Open(ctx context.Context, path string) (*DB, error) {
	dsn, err := buildDSN(path)
	if err != nil {
		return nil, err
	}

	handle, err := sql.Open(driverName, dsn)
	if err != nil {
		return nil, fmt.Errorf("storage: open database: %w", err)
	}

	// SQLite permits a single writer. Confining the pool to one connection
	// removes write contention and, for an in-memory database, keeps every
	// query on the one connection that holds the data.
	handle.SetMaxOpenConns(1)

	if err := handle.PingContext(ctx); err != nil {
		handle.Close()
		return nil, fmt.Errorf("storage: connect to database: %w", err)
	}

	db := &DB{sql: handle, path: path}
	if err := db.configure(ctx); err != nil {
		handle.Close()
		return nil, err
	}
	if err := db.migrate(ctx); err != nil {
		handle.Close()
		return nil, err
	}
	if err := db.restrictPermissions(); err != nil {
		handle.Close()
		return nil, err
	}
	return db, nil
}

// InMemory is the path that selects a private in-memory database.
const InMemory = ":memory:"

func buildDSN(path string) (string, error) {
	if path == InMemory {
		return ":memory:", nil
	}
	if path == "" {
		return "", errors.New("storage: database path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", fmt.Errorf("storage: create data directory: %w", err)
	}
	return path, nil
}

// configure applies the connection settings the daemon depends on.
func (db *DB) configure(ctx context.Context) error {
	pragmas := []string{
		// Enforce the REFERENCES clauses in the schema. SQLite ignores
		// them unless this is switched on per connection.
		"PRAGMA foreign_keys = ON",
		// Survive an abrupt power loss without a torn database, and let
		// reads proceed while a write is in flight.
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		// Wait rather than failing immediately if the file is briefly
		// locked by another process, such as a second daemon starting.
		"PRAGMA busy_timeout = 5000",
	}
	for _, p := range pragmas {
		if _, err := db.sql.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("storage: apply %q: %w", p, err)
		}
	}
	return nil
}

// restrictPermissions narrows the database file to its owner.
//
// The file is created by the driver, which does not take a mode, so the
// permissions are tightened immediately after it exists.
func (db *DB) restrictPermissions() error {
	if db.path == InMemory {
		return nil
	}
	// WAL mode creates sidecar files that hold the same data as the main
	// database, so all three are narrowed.
	for _, suffix := range []string{"", "-wal", "-shm"} {
		name := db.path + suffix
		if _, err := os.Stat(name); err != nil {
			continue // not every sidecar exists at every moment
		}
		if err := os.Chmod(name, dbFileMode); err != nil {
			return fmt.Errorf("storage: restrict permissions on %s: %w", filepath.Base(name), err)
		}
	}
	return nil
}

// migrate applies every migration not yet recorded, inside one transaction
// per migration.
//
// A migration and the row recording it commit together, so an interrupted
// upgrade can never leave the schema applied but unrecorded, or vice versa.
func (db *DB) migrate(ctx context.Context) error {
	if _, err := db.sql.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    INTEGER PRIMARY KEY,
		name       TEXT    NOT NULL,
		applied_at INTEGER NOT NULL
	)`); err != nil {
		return fmt.Errorf("storage: create migration table: %w", err)
	}

	var current int
	// COALESCE turns the empty-table case into 0 rather than a NULL scan
	// error, so a fresh database needs no special handling.
	if err := db.sql.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return fmt.Errorf("storage: read schema version: %w", err)
	}

	for _, m := range migrations {
		if m.version <= current {
			continue
		}
		if err := db.applyMigration(ctx, m); err != nil {
			return err
		}
	}
	return nil
}

func (db *DB) applyMigration(ctx context.Context, m migration) error {
	tx, err := db.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("storage: begin migration %d: %w", m.version, err)
	}
	defer tx.Rollback() //nolint:errcheck // no-op once the transaction commits

	for i, stmt := range m.stmts {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("storage: migration %d (%s) statement %d: %w", m.version, m.name, i+1, err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, unixepoch())`,
		m.version, m.name,
	); err != nil {
		return fmt.Errorf("storage: record migration %d: %w", m.version, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("storage: commit migration %d: %w", m.version, err)
	}
	return nil
}

// SchemaVersion returns the highest applied migration version.
func (db *DB) SchemaVersion(ctx context.Context) (int, error) {
	var v int
	if err := db.sql.QueryRowContext(ctx, `SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&v); err != nil {
		return 0, fmt.Errorf("storage: read schema version: %w", err)
	}
	return v, nil
}

// SQL exposes the underlying handle for the repository packages built on top
// of this one.
func (db *DB) SQL() *sql.DB { return db.sql }

// Path returns the database location.
func (db *DB) Path() string { return db.path }

// Close releases the database handle.
func (db *DB) Close() error {
	if err := db.sql.Close(); err != nil {
		return fmt.Errorf("storage: close database: %w", err)
	}
	return nil
}

// DefaultPath returns the database location inside the given data directory.
func DefaultPath(dataDir string) string {
	return filepath.Join(dataDir, "agentik.db")
}
