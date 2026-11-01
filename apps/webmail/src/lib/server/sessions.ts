import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const HOUR = 3_600_000;
export const IDLE_LIMIT = 2 * HOUR;
export const ABSOLUTE_LIMIT = 12 * HOUR;
export const RECHECK_AFTER = 5 * 60_000;
export const MAX_SESSIONS = 10;

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
}

export interface Session {
  tokenHash: string;
  user: SessionUser;
  checkedAt: number;
}

/** The SQLite keeps only this hash, never the token in the cookie. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** New 32-byte token; the oldest sessions beyond MAX_SESSIONS are dropped. checked_at 0: the first request revalidates with GET /v1/me. */
export function createSession(
  db: DatabaseSync,
  user: SessionUser,
  ip: string,
  now: number,
): string {
  const token = randomBytes(32).toString("base64url");
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, username, display_name, role, ip, created_at, last_seen_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    hashToken(token),
    user.id,
    user.username,
    user.displayName,
    user.role,
    ip,
    now,
    now,
    0,
  );
  db.prepare(
    `DELETE FROM sessions WHERE user_id = ?1 AND token_hash NOT IN
       (SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT ?2)`,
  ).run(user.id, MAX_SESSIONS);
  return token;
}

/** The live session for a cookie token, touching last_seen. Expired sessions are deleted. */
export function getSession(
  db: DatabaseSync,
  token: string,
  now: number,
): Session | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const tokenHash = hashToken(token);
  const row = db
    .prepare("SELECT * FROM sessions WHERE token_hash = ?")
    .get(tokenHash);
  if (!row) return null;
  if (
    now - Number(row.last_seen_at) >= IDLE_LIMIT ||
    now - Number(row.created_at) >= ABSOLUTE_LIMIT
  ) {
    deleteSession(db, tokenHash);
    return null;
  }
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(
    now,
    tokenHash,
  );
  return {
    tokenHash,
    checkedAt: Number(row.checked_at),
    user: {
      id: String(row.user_id),
      username: String(row.username),
      displayName: row.display_name === null ? null : String(row.display_name),
      role: String(row.role),
    },
  };
}

export function markChecked(
  db: DatabaseSync,
  tokenHash: string,
  user: SessionUser,
  now: number,
) {
  db.prepare(
    "UPDATE sessions SET checked_at = ?, username = ?, display_name = ?, role = ? WHERE token_hash = ?",
  ).run(now, user.username, user.displayName, user.role, tokenHash);
}

export function deleteSession(db: DatabaseSync, tokenHash: string) {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

export function deleteUserSessions(db: DatabaseSync, userId: string): number {
  return Number(
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId).changes,
  );
}

export function listSessions(db: DatabaseSync, username?: string) {
  const sql = `SELECT substr(token_hash, 1, 12) AS id, username, ip, created_at, last_seen_at FROM sessions
    ${username ? "WHERE username = ?" : ""} ORDER BY last_seen_at DESC`;
  return db.prepare(sql).all(...(username ? [username] : [])) as {
    id: string;
    username: string;
    ip: string;
    created_at: number;
    last_seen_at: number;
  }[];
}

/** By the 12-character id that sessions:list shows. */
export function deleteSessionById(db: DatabaseSync, id: string): number {
  if (!/^[0-9a-f]{12}$/.test(id)) return 0;
  return Number(
    db
      .prepare("DELETE FROM sessions WHERE substr(token_hash, 1, 12) = ?")
      .run(id).changes,
  );
}

/** Only a step after the last accepted one is stored; false means the code was already used. */
export function useTotpStep(
  db: DatabaseSync,
  userId: string,
  step: number,
): boolean {
  const result = db
    .prepare(
      `INSERT INTO totp_used (user_id, last_step) VALUES (?1, ?2)
       ON CONFLICT (user_id) DO UPDATE SET last_step = ?2 WHERE last_step < ?2`,
    )
    .run(userId, step);
  return Number(result.changes) === 1;
}

export function lastTotpStep(db: DatabaseSync, userId: string): number {
  const row = db
    .prepare("SELECT last_step FROM totp_used WHERE user_id = ?")
    .get(userId);
  return row ? Number(row.last_step) : -1;
}
