-- Etapa 2: receiving mail. Users and permissions come in Etapa 3.

CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK (name = lower(name)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE mailboxes (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE CHECK (address = lower(address)),
  domain_id INTEGER NOT NULL REFERENCES domains (id),
  display_name TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes (id),
  folder TEXT NOT NULL DEFAULT 'inbox'
    CHECK (folder IN ('inbox', 'spam', 'trash', 'archive', 'sent')),
  message_id TEXT,
  -- "sha256:<hex>" of Message-ID + From, Date, Subject, To; of the raw bytes without a Message-ID.
  dedupe_key TEXT NOT NULL,
  in_reply_to TEXT,
  references_ids TEXT,
  from_address TEXT,
  from_name TEXT,
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  snippet TEXT CHECK (length(snippet) <= 200),
  header_date TEXT,
  received_at TEXT NOT NULL,
  size INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  spf TEXT NOT NULL DEFAULT 'unknown',
  dkim TEXT NOT NULL DEFAULT 'unknown',
  dmarc TEXT NOT NULL DEFAULT 'unknown',
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  raw_key TEXT NOT NULL,
  body_key TEXT,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('ok', 'failed'))
);

CREATE UNIQUE INDEX messages_mailbox_dedupe_key ON messages (mailbox_id, dedupe_key);
CREATE INDEX messages_listing ON messages (mailbox_id, folder, received_at DESC);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  -- Display only: never used in an R2 key.
  filename TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  content_id TEXT,
  is_inline INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0, 1))
);

CREATE INDEX attachments_message ON attachments (message_id);
