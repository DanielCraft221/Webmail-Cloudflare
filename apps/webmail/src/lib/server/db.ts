import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Local SQLite: only disposable data (sessions, limits, bans). Users live in D1. */
export function defaultDbPath(): string {
  return (
    process.env.WEBMAIL_DB_PATH ||
    join(homedir(), ".local/share/webmail/webmail.db")
  );
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id, created_at);
CREATE TABLE IF NOT EXISTS failures (kind TEXT NOT NULL, key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS failures_key ON failures (kind, key, at);
CREATE TABLE IF NOT EXISTS bans (
  ip_key TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ban_history (ip_key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS locks (user_key TEXT PRIMARY KEY, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS totp_used (user_id TEXT PRIMARY KEY, last_step INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS setup_pending (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export function openDb(path = defaultDbPath()): DatabaseSync {
  if (path !== ":memory:")
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Owner-only files (the database and its -wal/-shm), whatever the umask of the shell.
  const umask = process.umask(0o077);
  try {
    const db = new DatabaseSync(path);
    // The CLI opens the same file while the webmail runs.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    return db;
  } finally {
    process.umask(umask);
  }
}
