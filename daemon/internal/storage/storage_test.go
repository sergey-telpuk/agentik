package storage

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(t.Context(), InMemory)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestOpenAppliesMigrations(t *testing.T) {
	db := openTestDB(t)
	v, err := db.SchemaVersion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	want := migrations[len(migrations)-1].version
	if v != want {
		t.Fatalf("schema version = %d, want %d", v, want)
	}
}

func TestExpectedTablesExist(t *testing.T) {
	db := openTestDB(t)
	want := []string{
		"trusted_clients", "projects", "agent_sessions", "tasks",
		"commands", "events", "approvals", "pairing_invitations",
	}
	for _, name := range want {
		var got string
		err := db.SQL().QueryRowContext(t.Context(),
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, name,
		).Scan(&got)
		if err != nil {
			t.Fatalf("table %s missing: %v", name, err)
		}
	}
}

// TestMigrationsAreIdempotent covers the ordinary restart path: reopening a
// database must not try to reapply a migration already recorded.
func TestMigrationsAreIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := DefaultPath(dir)

	first, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("first Open: %v", err)
	}
	v1, err := first.SchemaVersion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	second, err := Open(t.Context(), path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer second.Close()
	v2, err := second.SchemaVersion(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if v1 != v2 {
		t.Fatalf("schema version changed on reopen: %d then %d", v1, v2)
	}

	var count int
	if err := second.SQL().QueryRowContext(t.Context(),
		`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != len(migrations) {
		t.Fatalf("recorded %d migrations, want %d", count, len(migrations))
	}
}

func TestMigrationVersionsAreOrderedAndUnique(t *testing.T) {
	seen := map[int]bool{}
	prev := 0
	for _, m := range migrations {
		if m.version <= prev {
			t.Fatalf("migration %d (%s) is not greater than the previous %d", m.version, m.name, prev)
		}
		if seen[m.version] {
			t.Fatalf("duplicate migration version %d", m.version)
		}
		seen[m.version] = true
		prev = m.version
	}
}

// TestForeignKeysEnforced matters because SQLite silently ignores REFERENCES
// unless the pragma is on, which would let a task point at a session that
// does not exist.
func TestForeignKeysEnforced(t *testing.T) {
	db := openTestDB(t)
	_, err := db.SQL().ExecContext(t.Context(),
		`INSERT INTO agent_sessions (id, project_id, adapter, created_at)
		 VALUES ('s1', 'no-such-project', 'codex', 1)`)
	if err == nil {
		t.Fatal("inserted a session referencing a missing project")
	}
}

// TestTaskStateConstraint checks that the documented state set is enforced by
// the schema, so an unrecognised state cannot reach the interface.
func TestTaskStateConstraint(t *testing.T) {
	db := openTestDB(t)
	ctx := t.Context()
	seedTaskPrerequisites(t, db)

	if _, err := db.SQL().ExecContext(ctx,
		`INSERT INTO tasks (id, session_id, client_id, prompt, state, created_at, updated_at)
		 VALUES ('t1', 's1', 1, 'do it', 'definitely-done', 1, 1)`); err == nil {
		t.Fatal("accepted an undefined task state")
	}

	if _, err := db.SQL().ExecContext(ctx,
		`INSERT INTO tasks (id, session_id, client_id, prompt, state, created_at, updated_at)
		 VALUES ('t2', 's1', 1, 'do it', 'recovery_required', 1, 1)`); err != nil {
		t.Fatalf("rejected a documented task state: %v", err)
	}
}

// TestCommandDeduplicationIsPerClient covers the idempotency rule: a request
// id is unique per client, and one client's id must not collide with
// another's.
func TestCommandDeduplicationIsPerClient(t *testing.T) {
	db := openTestDB(t)
	ctx := t.Context()
	seedTaskPrerequisites(t, db)
	insertClient(t, db, 2, []byte("client-two-key"))

	insert := func(clientID int, requestID string) error {
		_, err := db.SQL().ExecContext(ctx,
			`INSERT INTO commands (client_id, request_id, method, content_hash, created_at)
			 VALUES (?, ?, 'task.start', X'00', 1)`, clientID, requestID)
		return err
	}

	if err := insert(1, "req-1"); err != nil {
		t.Fatalf("first insert: %v", err)
	}
	if err := insert(1, "req-1"); err == nil {
		t.Fatal("same client reused a request id without conflict")
	}
	if err := insert(2, "req-1"); err != nil {
		t.Fatalf("a different client must be free to use the same request id: %v", err)
	}
}

// TestEventSequenceIsPerSession checks the resume cursor's uniqueness scope.
func TestEventSequenceIsPerSession(t *testing.T) {
	db := openTestDB(t)
	ctx := t.Context()
	seedTaskPrerequisites(t, db)
	if _, err := db.SQL().ExecContext(ctx,
		`INSERT INTO agent_sessions (id, project_id, adapter, created_at)
		 VALUES ('s2', 'p1', 'codex', 1)`); err != nil {
		t.Fatal(err)
	}

	insert := func(session string, seq int) error {
		_, err := db.SQL().ExecContext(ctx,
			`INSERT INTO events (session_id, seq, kind, payload, created_at)
			 VALUES (?, ?, 'log', '{}', 1)`, session, seq)
		return err
	}

	if err := insert("s1", 1); err != nil {
		t.Fatal(err)
	}
	if err := insert("s1", 1); err == nil {
		t.Fatal("duplicate sequence number accepted within one session")
	}
	if err := insert("s2", 1); err != nil {
		t.Fatalf("sequence numbers must restart per session: %v", err)
	}
}

func TestTrustedClientKeyIsUnique(t *testing.T) {
	db := openTestDB(t)
	insertClient(t, db, 1, []byte("duplicate-key"))
	_, err := db.SQL().ExecContext(t.Context(),
		`INSERT INTO trusted_clients (id, noise_public_key, telegram_user_id, paired_at)
		 VALUES (2, ?, 99, 1)`, []byte("duplicate-key"))
	if err == nil {
		t.Fatal("the same phone key was paired twice")
	}
}

func TestInvitationHashIsUnique(t *testing.T) {
	db := openTestDB(t)
	ctx := t.Context()
	insert := func(id string) error {
		_, err := db.SQL().ExecContext(ctx,
			`INSERT INTO pairing_invitations (id, secret_hash, state, created_at, expires_at)
			 VALUES (?, X'AABB', 'pending', 1, 2)`, id)
		return err
	}
	if err := insert("i1"); err != nil {
		t.Fatal(err)
	}
	if err := insert("i2"); err == nil {
		t.Fatal("the same invitation hash was stored twice")
	}
}

func TestOpenRejectsEmptyPath(t *testing.T) {
	if _, err := Open(t.Context(), ""); err == nil {
		t.Fatal("empty database path was accepted")
	}
}

func TestDatabaseFileIsOwnerOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permission bits are not meaningful on Windows")
	}
	path := DefaultPath(t.TempDir())
	db, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != dbFileMode {
		t.Fatalf("database mode is %o, want %o", perm, dbFileMode)
	}
}

func TestDefaultPathIsInsideDataDir(t *testing.T) {
	dir := t.TempDir()
	if got, want := DefaultPath(dir), filepath.Join(dir, "agentik.db"); got != want {
		t.Fatalf("DefaultPath = %q, want %q", got, want)
	}
}

// seedTaskPrerequisites inserts the rows a task depends on: one client, one
// project, and one session.
func seedTaskPrerequisites(t *testing.T, db *DB) {
	t.Helper()
	ctx := context.Background()
	insertClient(t, db, 1, []byte("client-one-key"))
	if _, err := db.SQL().ExecContext(ctx,
		`INSERT INTO projects (id, name, path, allowed_agent, created_at)
		 VALUES ('p1', 'Demo', '/tmp/demo', 'codex', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.SQL().ExecContext(ctx,
		`INSERT INTO agent_sessions (id, project_id, adapter, created_at)
		 VALUES ('s1', 'p1', 'codex', 1)`); err != nil {
		t.Fatal(err)
	}
}

func insertClient(t *testing.T, db *DB, id int, key []byte) {
	t.Helper()
	if _, err := db.SQL().ExecContext(context.Background(),
		`INSERT INTO trusted_clients (id, noise_public_key, telegram_user_id, paired_at)
		 VALUES (?, ?, 4242, 1)`, id, key); err != nil {
		t.Fatal(err)
	}
}

// TestModelColumnUpgradeKeepsExistingTasks reopens a database that is still at
// schema v1 (no tasks.model) and checks that migration v2 adds the column
// without losing rows, which then read back as "the agent's default model".
func TestModelColumnUpgradeKeepsExistingTasks(t *testing.T) {
	ctx := t.Context()
	path := filepath.Join(t.TempDir(), "agentik.db")

	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	seedTaskPrerequisites(t, db)
	for _, stmt := range []string{
		`ALTER TABLE tasks DROP COLUMN model`,
		`DELETE FROM schema_migrations WHERE version = 2`,
		`INSERT INTO tasks (id, session_id, client_id, prompt, state, created_at, updated_at)
		 VALUES ('old', 's1', 1, 'before models', 'succeeded', 1, 1)`,
	} {
		if _, err := db.SQL().ExecContext(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen at schema v1: %v", err)
	}
	defer db.Close()
	var model string
	if err := db.SQL().QueryRowContext(ctx, `SELECT model FROM tasks WHERE id = 'old'`).Scan(&model); err != nil {
		t.Fatal(err)
	}
	if model != "" {
		t.Fatalf("pre-existing task model = %q, want empty", model)
	}
}
