import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/lib/server/cli/main.ts";
import { clean } from "../src/lib/server/cli/output.ts";
import { openDb } from "../src/lib/server/db.ts";
import { ipKey } from "../src/lib/server/ip.ts";
import {
  banUntil,
  lockUntil,
  userFailure,
  userKey,
} from "../src/lib/server/limits.ts";
import { createSession, listSessions } from "../src/lib/server/sessions.ts";
import { FAKE, startFakeWorker } from "./fake-worker.ts";

let fake: Awaited<ReturnType<typeof startFakeWorker>>;
const db = openDb(":memory:");
let output: string[] = [];

beforeAll(async () => {
  fake = await startFakeWorker();
});
afterAll(() => fake.close());

const cli = () => ({
  api: {
    apiUrl: fake.url,
    bearer: FAKE.adminToken,
    accessClientId: FAKE.accessId,
    accessClientSecret: FAKE.accessSecret,
  },
  origin: "http://localhost:4173",
  db: () => db,
  out: (text: string) => output.push(text),
});
const admin = async (...args: string[]) => {
  output = [];
  const code = await run(args, cli);
  return { code, text: output.join("\n") };
};

describe("clean", () => {
  it("makes control and format characters visible", () => {
    expect(clean("ok\u001b[2J\u202egone\r\n")).toBe(
      "ok\\u{1b}[2J\\u{202e}gone\\u{d}\\u{a}",
    );
    expect(clean(null)).toBe("-");
  });
});

describe("pnpm admin", () => {
  it("user:create shows the setup link once and sends only its hash", async () => {
    const { code, text } = await admin(
      "user:create",
      "ana",
      "--name",
      "Ana",
      "--role",
      "admin",
    );
    expect(code).toBe(0);
    const link = /http:\/\/localhost:4173\/setup\/([A-Za-z0-9_-]{43})/.exec(
      text,
    );
    expect(link).not.toBeNull();
    const stored = [...fake.store.users.values()].find(
      (u) => u.username === "ana",
    );
    expect(stored?.setupTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(link?.[1]);
    await expect(admin("user:create", "ana")).rejects.toThrow(/already exists/);
  });

  it("user:list shows no secret", async () => {
    const ana = [...fake.store.users.values()].find(
      (u) => u.username === "ana",
    );
    if (ana)
      Object.assign(ana, {
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA",
        totpSecretEnc: "v1.aaaa.bbbb",
      });
    const { text } = await admin("user:list");
    expect(text).toMatch(/ana\s+Ana\s+admin\s+sim\s+sim\s+sim/);
    expect(text).not.toMatch(/argon2|v1\.aaaa|[0-9a-f]{64}/);
  });

  it("user:reset clears the password, 2FA and local sessions and shows a new link", async () => {
    const ana = [...fake.store.users.values()].find(
      (u) => u.username === "ana",
    );
    createSession(
      db,
      { id: ana?.id ?? "", username: "ana", displayName: null, role: "admin" },
      "203.0.113.7",
      Date.now(),
    );
    const { text } = await admin("user:reset", "ana");
    expect(text).toMatch(/Sessões derrubadas: 1/);
    expect(text).toMatch(/\/setup\/[A-Za-z0-9_-]{43}/);
    expect(ana?.passwordHash).toBeNull();
    expect(ana?.totpSecretEnc).toBeNull();
    expect(listSessions(db, "ana")).toHaveLength(0);
  });

  it("user:disable drops sessions; user:role changes the role", async () => {
    const ana = [...fake.store.users.values()].find(
      (u) => u.username === "ana",
    );
    createSession(
      db,
      { id: ana?.id ?? "", username: "ana", displayName: null, role: "admin" },
      "203.0.113.7",
      Date.now(),
    );
    expect((await admin("user:disable", "ana")).text).toMatch(
      /Sessões derrubadas: 1/,
    );
    expect(ana?.active).toBe(false);
    await admin("user:enable", "ana");
    expect(ana?.active).toBe(true);
    await admin("user:role", "ana", "user");
    expect(ana?.role).toBe("user");
  });

  it("ban and lock commands change the local SQLite and go to the audit log", async () => {
    await admin("ban:add", "2001:db8:9:9::5", "--hours", "2");
    expect(banUntil(db, ipKey("2001:db8:9:9::1"), Date.now())).not.toBeNull();
    expect((await admin("ban:list")).text).toContain(
      "2001:0db8:0009:0009::/64",
    );
    await admin("ban:remove", "2001:db8:9:9::7");
    expect(banUntil(db, ipKey("2001:db8:9:9::1"), Date.now())).toBeNull();

    const now = Date.now();
    const [a, b] = [ipKey("198.51.100.1"), ipKey("198.51.100.2")];
    for (let i = 0; i < 5; i++) userFailure(db, "ana", a, now);
    for (let i = 0; i < 5; i++) userFailure(db, "ana", b, now);
    db.prepare("INSERT INTO locks (user_key, until) VALUES (?, ?)").run(
      userKey("ana"),
      now + 60_000,
    );
    expect(lockUntil(db, "ana", a, now)).not.toBeNull();
    expect(lockUntil(db, "ana", b, now)).not.toBeNull();
    expect(await admin("lock:clear", "ana")).toMatchObject({
      text: expect.stringContaining("Bloqueio removido"),
    });
    expect(lockUntil(db, "ana", a, now)).toBeNull();
    expect(lockUntil(db, "ana", b, now)).toBeNull();
    expect(lockUntil(db, "ana", ipKey("192.0.2.9"), now)).toBeNull();

    const actions = fake.store.audit
      .filter((e) => e.source === "cli")
      .map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(["ip_ban", "ip_unban", "username_unlock"]),
    );
  });

  it("audit:list escapes control characters stored in D1", async () => {
    fake.store.audit.push({
      id: 999,
      createdAt: new Date().toISOString(),
      source: "webmail",
      actorUserId: null,
      action: "login_failure",
      target: "\u001b[2J\u001b[1;1Hforged",
      ip: null,
      detail: { reason: "\u202ebad" },
    });
    const { text } = await admin("audit:list", "--limit", "5");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u202e");
    expect(text).toContain("\\u{1b}[2J");
  });
});

describe("admin.env", () => {
  const dir = mkdtempSync(join(tmpdir(), "webmail-cli-"));
  const file = join(dir, "admin.env");
  const runCli = () =>
    execFileSync(
      process.execPath,
      ["src/lib/server/cli/main.ts", "user:list"],
      {
        env: { PATH: process.env.PATH, HOME: dir, WEBMAIL_ADMIN_ENV: file },
        encoding: "utf8",
        stdio: "pipe",
      },
    );

  it("refuses a file that is not 600", () => {
    writeFileSync(
      file,
      "ADMIN_API_TOKEN=fake\nCF_ACCESS_CLIENT_ID=x\nCF_ACCESS_CLIENT_SECRET=y\n",
    );
    chmodSync(file, 0o644);
    expect(runCli).toThrow(/permission 600/);
    chmodSync(file, 0o640);
    expect(runCli).toThrow(/permission 600/);
  });
});
