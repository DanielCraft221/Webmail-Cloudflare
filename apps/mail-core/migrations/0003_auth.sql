-- Etapa 5: login data and the audit log (docs/webmail-auth.md).
-- A user without password_hash or totp_secret_enc can never log in, even when active.

ALTER TABLE users ADD COLUMN password_hash TEXT;
-- AES-256-GCM with a key only the webmail holds; the user id is the associated data.
ALTER TABLE users ADD COLUMN totp_secret_enc TEXT;
-- SHA-256 of the setup link token, never the token.
ALTER TABLE users ADD COLUMN setup_token_hash TEXT;
ALTER TABLE users ADD COLUMN setup_expires_at TEXT;
ALTER TABLE users ADD COLUMN updated_at TEXT;

-- ALTER TABLE cannot add a UNIQUE column. A unique index does the same and allows many NULLs.
CREATE UNIQUE INDEX users_setup_token ON users (setup_token_hash);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Set by the token that wrote the event, never by the request body.
  source TEXT NOT NULL CHECK (source IN ('cli', 'webmail')),
  actor_user_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  ip TEXT,
  -- Short flat JSON. Never a password, code, token or cookie.
  detail TEXT
);

CREATE INDEX audit_log_created ON audit_log (created_at DESC, id DESC);
