package storage

// migrations are applied in order and recorded in schema_migrations. A
// migration is never edited once released: a correction is a new migration,
// because an edited one would leave existing installations on a schema that
// no longer matches its recorded version.
var migrations = []migration{
	{
		version: 1,
		name:    "initial schema",
		stmts: []string{
			// Paired phones. The public key is the identity that matters;
			// the Telegram id is recorded alongside it but is not on its
			// own a credential, so a matching Telegram account with a
			// different key gets no access.
			`CREATE TABLE trusted_clients (
				id                 INTEGER PRIMARY KEY AUTOINCREMENT,
				noise_public_key   BLOB    NOT NULL UNIQUE,
				telegram_user_id   INTEGER NOT NULL,
				label              TEXT    NOT NULL DEFAULT '',
				paired_at          INTEGER NOT NULL,
				revoked_at         INTEGER,
				last_seen_at       INTEGER
			)`,
			// Revoked keys are looked up on every connection, so the
			// partial index keeps that check cheap as the table grows.
			`CREATE INDEX idx_trusted_clients_active
				ON trusted_clients (noise_public_key) WHERE revoked_at IS NULL`,

			// Projects the user has explicitly permitted. A path reaches
			// an agent only by resolving a row here, never straight from
			// the network.
			`CREATE TABLE projects (
				id             TEXT    PRIMARY KEY,
				name           TEXT    NOT NULL,
				path           TEXT    NOT NULL UNIQUE,
				allowed_agent  TEXT    NOT NULL,
				created_at     INTEGER NOT NULL,
				removed_at     INTEGER
			)`,

			// A dialogue with an agent. agent_thread_id links it to the
			// adapter's own session so work can be resumed after a
			// restart; it stays NULL until the agent reports one.
			`CREATE TABLE agent_sessions (
				id               TEXT    PRIMARY KEY,
				project_id       TEXT    NOT NULL REFERENCES projects(id),
				adapter          TEXT    NOT NULL,
				agent_thread_id  TEXT,
				created_at       INTEGER NOT NULL,
				closed_at        INTEGER
			)`,
			`CREATE INDEX idx_agent_sessions_project ON agent_sessions (project_id)`,

			// Tasks. state is constrained to the documented set so an
			// unknown value cannot be written and later read back as if
			// it meant something.
			`CREATE TABLE tasks (
				id           TEXT    PRIMARY KEY,
				session_id   TEXT    NOT NULL REFERENCES agent_sessions(id),
				client_id    INTEGER NOT NULL REFERENCES trusted_clients(id),
				prompt       TEXT    NOT NULL,
				state        TEXT    NOT NULL CHECK (state IN (
					'accepted','starting','running','awaiting_approval',
					'cancel_requested','succeeded','failed','cancelled',
					'recovery_required'
				)),
				result       TEXT,
				error        TEXT,
				created_at   INTEGER NOT NULL,
				updated_at   INTEGER NOT NULL
			)`,
			`CREATE INDEX idx_tasks_session ON tasks (session_id)`,

			// Deduplication of inbound commands. Uniqueness is per client
			// and request id, so one client's request id cannot collide
			// with or overwrite another's.
			`CREATE TABLE commands (
				client_id     INTEGER NOT NULL REFERENCES trusted_clients(id),
				request_id    TEXT    NOT NULL,
				method        TEXT    NOT NULL,
				content_hash  BLOB    NOT NULL,
				task_id       TEXT    REFERENCES tasks(id),
				created_at    INTEGER NOT NULL,
				PRIMARY KEY (client_id, request_id)
			)`,

			// Ordered events within a session. The sequence number is what
			// a reconnecting client resumes from, so it is unique per
			// session rather than global.
			`CREATE TABLE events (
				session_id  TEXT    NOT NULL REFERENCES agent_sessions(id),
				seq         INTEGER NOT NULL,
				task_id     TEXT    REFERENCES tasks(id),
				kind        TEXT    NOT NULL,
				payload     TEXT    NOT NULL,
				created_at  INTEGER NOT NULL,
				PRIMARY KEY (session_id, seq)
			)`,

			// Pending decisions on individual agent operations. An
			// approval is bound to one task and one action and carries an
			// expiry, so a stale decision cannot be applied later.
			`CREATE TABLE approvals (
				id          TEXT    PRIMARY KEY,
				task_id     TEXT    NOT NULL REFERENCES tasks(id),
				session_id  TEXT    NOT NULL REFERENCES agent_sessions(id),
				action      TEXT    NOT NULL,
				state       TEXT    NOT NULL CHECK (state IN ('pending','approved','rejected','expired')),
				created_at  INTEGER NOT NULL,
				expires_at  INTEGER NOT NULL,
				resolved_at INTEGER
			)`,
			`CREATE INDEX idx_approvals_task ON approvals (task_id)`,

			// One-time pairing invitations. Only the hash is stored: a
			// copy of this database does not yield a usable invitation.
			`CREATE TABLE pairing_invitations (
				id            TEXT    PRIMARY KEY,
				secret_hash   BLOB    NOT NULL UNIQUE,
				state         TEXT    NOT NULL CHECK (state IN ('pending','consumed','expired','rejected')),
				attempts      INTEGER NOT NULL DEFAULT 0,
				created_at    INTEGER NOT NULL,
				expires_at    INTEGER NOT NULL,
				consumed_at   INTEGER
			)`,
		},
	},
	{
		version: 2,
		name:    "task model selection",
		stmts: []string{
			// The model a task was started with. Empty means the agent's own
			// default model; it is recorded so an idempotent retry and the
			// task history report what was actually requested.
			`ALTER TABLE tasks ADD COLUMN model TEXT NOT NULL DEFAULT ''`,
		},
	},
}
