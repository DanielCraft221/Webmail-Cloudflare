import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/server/db.ts";
import {
  ABSOLUTE_LIMIT,
  createSession,
  deleteSessionById,
  getSession,
  hashToken,
  IDLE_LIMIT,
  listSessions,
  MAX_SESSIONS,
  useTotpStep,
} from "../src/lib/server/sessions.ts";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  username: "ana",
  displayName: null,
  role: "user",
};

describe("sessions", () => {
  it("stores only the SHA-256 of the token", () => {
    const db = openDb(":memory:");
    const token = createSession(db, user, "203.0.113.7", 0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = db.prepare("SELECT * FROM sessions").all();
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.token_hash).toBe(hashToken(token));
    expect(getSession(db, token, 1)?.user.username).toBe("ana");
  });

  it("expires after 2 h idle and after 12 h in total", () => {
    const db = openDb(":memory:");
    const idle = createSession(db, user, "ip", 0);
    expect(getSession(db, idle, IDLE_LIMIT - 1)).not.toBeNull();
    expect(getSession(db, idle, 2 * IDLE_LIMIT - 1)).toBeNull();
    expect(getSession(db, idle, 0)).toBeNull(); // deleted, not just hidden

    const busy = createSession(db, user, "ip", 0);
    let now = 0;
    while (now + IDLE_LIMIT / 2 < ABSOLUTE_LIMIT) {
      now += IDLE_LIMIT / 2;
      expect(getSession(db, busy, now)).not.toBeNull();
    }
    expect(getSession(db, busy, ABSOLUTE_LIMIT)).toBeNull();
  });

  it("keeps at most 10 sessions per user, dropping the oldest", () => {
    const db = openDb(":memory:");
    const tokens = Array.from({ length: MAX_SESSIONS + 1 }, (_, i) =>
      createSession(db, user, "ip", i),
    );
    expect(listSessions(db, "ana")).toHaveLength(MAX_SESSIONS);
    expect(getSession(db, tokens[0] ?? "", 20)).toBeNull();
    expect(getSession(db, tokens[1] ?? "", 20)).not.toBeNull();
    const id = listSessions(db, "ana")[0]?.id ?? "";
    expect(deleteSessionById(db, id)).toBe(1);
  });

  it("refuses malformed tokens without a lookup", () => {
    const db = openDb(":memory:");
    expect(getSession(db, "' OR 1=1 --", 0)).toBeNull();
  });
});

describe("useTotpStep", () => {
  it("accepts only steps after the last one", () => {
    const db = openDb(":memory:");
    expect(useTotpStep(db, user.id, 100)).toBe(true);
    expect(useTotpStep(db, user.id, 100)).toBe(false);
    expect(useTotpStep(db, user.id, 99)).toBe(false);
    expect(useTotpStep(db, user.id, 101)).toBe(true);
  });
});

describe("openDb", () => {
  it("creates the database files for the owner only", async () => {
    const { mkdtempSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "webmail-db-"));
    const db = openDb(join(dir, "sub", "webmail.db"));
    createSession(db, user, "ip", 0);
    for (const file of ["sub", "sub/webmail.db", "sub/webmail.db-wal"])
      expect(statSync(join(dir, file)).mode & 0o077).toBe(0);
  });
});
