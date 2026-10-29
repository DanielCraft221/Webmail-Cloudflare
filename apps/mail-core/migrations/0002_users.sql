-- Etapa 3: users and per-mailbox permissions. Password and 2FA columns come in Etapa 5.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE
    CHECK (username = lower(username) AND length(username) BETWEEN 1 AND 64),
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE user_mailboxes (
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  can_read INTEGER NOT NULL DEFAULT 1 CHECK (can_read IN (0, 1)),
  -- Sending comes in Etapa 8.
  can_send INTEGER NOT NULL DEFAULT 0 CHECK (can_send IN (0, 1)),
  PRIMARY KEY (user_id, mailbox_id)
);

-- A user's mailboxes. The primary key already starts with user_id; this keeps the lookup explicit.
CREATE INDEX user_mailboxes_user ON user_mailboxes (user_id, can_read);

-- Cursor pagination orders by (received_at, id): the index needs the id as tie-breaker.
DROP INDEX messages_listing;
CREATE INDEX messages_listing ON messages (mailbox_id, folder, received_at DESC, id DESC);
