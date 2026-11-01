import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const MINUTE = 60_000;
export const FAILURE_WINDOW = 15 * MINUTE;
export const IP_FAILURES = 10;
export const USER_FAILURES = 5;
export const LOCK_DURATION = 15 * MINUTE;
/** First ban 15 min; further bans within 7 days: 1 h, then 24 h. */
export const BAN_STEPS = [15 * MINUTE, 60 * MINUTE, 24 * 60 * MINUTE] as const;
const BAN_MEMORY = 7 * 24 * 60 * MINUTE;
export const SETUP_HITS = 30;

/** Usernames are kept only as a hash: people sometimes type their password in that field. */
export function userKey(username: string): string {
  return createHash("sha256")
    .update(`user:${username.trim().toLowerCase()}`)
    .digest("hex");
}

export function banUntil(
  db: DatabaseSync,
  ipKey: string,
  now: number,
): number | null {
  const row = db
    .prepare("SELECT until FROM bans WHERE ip_key = ? AND until > ?")
    .get(ipKey, now);
  return row ? Number(row.until) : null;
}

export function lockUntil(
  db: DatabaseSync,
  key: string,
  now: number,
): number | null {
  const row = db
    .prepare("SELECT until FROM locks WHERE user_key = ? AND until > ?")
    .get(key, now);
  return row ? Number(row.until) : null;
}

function count(
  db: DatabaseSync,
  kind: string,
  key: string,
  since: number,
): number {
  const row = db
    .prepare(
      "SELECT count(*) AS n FROM failures WHERE kind = ? AND key = ? AND at > ?",
    )
    .get(kind, key, since);
  return Number(row?.n ?? 0);
}

/** Records a failed attempt from an IP. Returns the ban length in ms when this failure starts a ban. */
export function ipFailure(
  db: DatabaseSync,
  ipKey: string,
  now: number,
): number | null {
  db.prepare("INSERT INTO failures (kind, key, at) VALUES ('ip', ?, ?)").run(
    ipKey,
    now,
  );
  if (count(db, "ip", ipKey, now - FAILURE_WINDOW) < IP_FAILURES) return null;
  const previous = db
    .prepare(
      "SELECT count(*) AS n FROM ban_history WHERE ip_key = ? AND at > ?",
    )
    .get(ipKey, now - BAN_MEMORY);
  const length =
    BAN_STEPS[Math.min(Number(previous?.n ?? 0), BAN_STEPS.length - 1)] ?? 0;
  addBan(db, ipKey, now, length, "failures");
  db.prepare("INSERT INTO ban_history (ip_key, at) VALUES (?, ?)").run(
    ipKey,
    now,
  );
  db.prepare("DELETE FROM failures WHERE kind = 'ip' AND key = ?").run(ipKey);
  return length;
}

/** Records a failed login for a username. Returns true when this failure locks it. */
export function userFailure(
  db: DatabaseSync,
  key: string,
  now: number,
): boolean {
  db.prepare("INSERT INTO failures (kind, key, at) VALUES ('user', ?, ?)").run(
    key,
    now,
  );
  if (count(db, "user", key, now - FAILURE_WINDOW) < USER_FAILURES)
    return false;
  db.prepare(
    "INSERT OR REPLACE INTO locks (user_key, until) VALUES (?, ?)",
  ).run(key, now + LOCK_DURATION);
  db.prepare("DELETE FROM failures WHERE kind = 'user' AND key = ?").run(key);
  return true;
}

export function clearUser(db: DatabaseSync, key: string): number {
  db.prepare("DELETE FROM failures WHERE kind = 'user' AND key = ?").run(key);
  return Number(
    db.prepare("DELETE FROM locks WHERE user_key = ?").run(key).changes,
  );
}

export function addBan(
  db: DatabaseSync,
  ipKey: string,
  now: number,
  length: number,
  reason: string,
) {
  db.prepare(
    "INSERT OR REPLACE INTO bans (ip_key, until, created_at, reason) VALUES (?, ?, ?, ?)",
  ).run(ipKey, now + length, now, reason);
}

export function removeBan(db: DatabaseSync, ipKey: string): number {
  db.prepare("DELETE FROM failures WHERE kind = 'ip' AND key = ?").run(ipKey);
  return Number(
    db.prepare("DELETE FROM bans WHERE ip_key = ?").run(ipKey).changes,
  );
}

export function listBans(db: DatabaseSync, now: number) {
  return db
    .prepare(
      "SELECT ip_key, until, created_at, reason FROM bans WHERE until > ? ORDER BY until",
    )
    .all(now) as {
    ip_key: string;
    until: number;
    created_at: number;
    reason: string;
  }[];
}

/** Plain request counter for /setup (failures there also count toward the IP ban). */
export function setupHit(
  db: DatabaseSync,
  ipKey: string,
  now: number,
): boolean {
  db.prepare("INSERT INTO failures (kind, key, at) VALUES ('setup', ?, ?)").run(
    ipKey,
    now,
  );
  return count(db, "setup", ipKey, now - FAILURE_WINDOW) <= SETUP_HITS;
}

export function prune(db: DatabaseSync, now: number) {
  db.prepare("DELETE FROM failures WHERE at <= ?").run(now - FAILURE_WINDOW);
  db.prepare("DELETE FROM bans WHERE until <= ?").run(now);
  db.prepare("DELETE FROM locks WHERE until <= ?").run(now);
  db.prepare("DELETE FROM ban_history WHERE at <= ?").run(now - BAN_MEMORY);
  db.prepare("DELETE FROM setup_pending WHERE expires_at <= ?").run(now);
}
