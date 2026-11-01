import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const MINUTE = 60_000;
export const FAILURE_WINDOW = 15 * MINUTE;
export const IP_FAILURES = 10;
/** Per username and IP block: one IP alone can only lock the username for itself. */
export const USER_IP_FAILURES = 5;
/** Per username from every IP together: needs many IPs, each one also heading for a ban. */
export const USER_FAILURES = 50;
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

/** Lock key for one username and one IP block (ipKey): "<userKey>:<ipKey>". */
function pairKey(username: string, ipKey: string): string {
  return `${userKey(username)}:${ipKey}`;
}

/** The username lock that applies to this IP block: the global one or the one for the pair. */
export function lockUntil(
  db: DatabaseSync,
  username: string,
  ipKey: string,
  now: number,
): number | null {
  const row = db
    .prepare(
      "SELECT max(until) AS until FROM locks WHERE user_key IN (?, ?) AND until > ?",
    )
    .get(userKey(username), pairKey(username, ipKey), now);
  return row?.until == null ? null : Number(row.until);
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

/**
 * Records a failed login for a username from an IP block. Returns which lock this failure
 * starts: "global" (every IP), "ip" (only this IP block) or null. Callers skip it while a
 * lock is active, so attempts during a lock never extend it.
 */
export function userFailure(
  db: DatabaseSync,
  username: string,
  ipKey: string,
  now: number,
): "global" | "ip" | null {
  const checks = [
    ["user", userKey(username), USER_FAILURES, "global"],
    ["user_ip", pairKey(username, ipKey), USER_IP_FAILURES, "ip"],
  ] as const;
  for (const [kind, key] of checks)
    db.prepare("INSERT INTO failures (kind, key, at) VALUES (?, ?, ?)").run(
      kind,
      key,
      now,
    );
  for (const [kind, key, limit, scope] of checks) {
    if (count(db, kind, key, now - FAILURE_WINDOW) < limit) continue;
    db.prepare(
      "INSERT OR REPLACE INTO locks (user_key, until) VALUES (?, ?)",
    ).run(key, now + LOCK_DURATION);
    db.prepare("DELETE FROM failures WHERE kind = ? AND key = ?").run(
      kind,
      key,
    );
    return scope;
  }
  return null;
}

/** After a successful login: forgets the failures of the username and of this IP block. */
export function clearUserFailures(
  db: DatabaseSync,
  username: string,
  ipKey: string,
) {
  db.prepare(
    "DELETE FROM failures WHERE (kind = 'user' AND key = ?) OR (kind = 'user_ip' AND key = ?)",
  ).run(userKey(username), pairKey(username, ipKey));
}

/** CLI lock:clear: the global lock and the locks of every IP block, with their failures. Returns the locks removed. */
export function clearUser(db: DatabaseSync, username: string): number {
  const key = userKey(username);
  const prefix = `${key}:`;
  db.prepare(
    "DELETE FROM failures WHERE (kind = 'user' AND key = ?1) OR (kind = 'user_ip' AND substr(key, 1, length(?2)) = ?2)",
  ).run(key, prefix);
  return Number(
    db
      .prepare(
        "DELETE FROM locks WHERE user_key = ?1 OR substr(user_key, 1, length(?2)) = ?2",
      )
      .run(key, prefix).changes,
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
