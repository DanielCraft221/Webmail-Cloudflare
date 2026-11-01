import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/lib/server/db.ts";
import { ipKey } from "../src/lib/server/ip.ts";
import { addBan, userKey } from "../src/lib/server/limits.ts";
import {
  attemptLogin,
  BANNED_ERROR,
  GENERIC_ERROR,
  type LoginDeps,
} from "../src/lib/server/login.ts";
import { encryptSecret } from "../src/lib/server/secret-box.ts";
import { getSession } from "../src/lib/server/sessions.ts";
import { base32Decode, hotp, stepAt } from "../src/lib/server/totp.ts";
import type { WebmailApi } from "../src/lib/server/worker-api.ts";

const NOW = 1_700_000_000_000;
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const ANA = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const code = (step = stepAt(NOW)) => hotp(base32Decode(SECRET), step);

type LookupUser = Awaited<ReturnType<WebmailApi["authLookup"]>>;

function setup(users: Record<string, LookupUser> = {}) {
  const key = randomBytes(32);
  const audits: Parameters<WebmailApi["audit"]>[0][] = [];
  const api = {
    authLookup: vi.fn(async (u: string) => users[u] ?? null),
    audit: vi.fn(async (b: Parameters<WebmailApi["audit"]>[0]) => {
      audits.push(b);
    }),
  } as unknown as WebmailApi;
  // A fake hash keeps the tests fast; the real argon2 has its own tests.
  const verifyPassword = vi.fn(
    async (hash: string, pw: string) => hash === `hash:${pw}`,
  );
  const deps: LoginDeps = {
    db: openDb(":memory:"),
    api,
    totpKey: key,
    verifyPassword,
    dummyHash: "dummy",
    now: () => NOW,
  };
  const user = (
    id: string,
    extra: Partial<NonNullable<LookupUser>> = {},
  ): NonNullable<LookupUser> => ({
    id,
    active: true,
    role: "user",
    passwordHash: "hash:right password",
    totpSecretEnc: encryptSecret(key, id, SECRET),
    ...extra,
  });
  return { deps, audits, verifyPassword, api, user };
}

describe("attemptLogin", () => {
  it("logs in with the right password and code, storing only the token hash", async () => {
    const t = setup();
    (t.api.authLookup as ReturnType<typeof vi.fn>).mockResolvedValue(
      t.user(ANA),
    );
    const result = await attemptLogin(t.deps, "203.0.113.7", {
      username: " Ana ",
      password: "right password",
      code: code(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(t.api.authLookup).toHaveBeenCalledWith("ana");
    expect(getSession(t.deps.db, result.token, NOW)?.user.id).toBe(ANA);
    expect(t.audits.at(-1)).toMatchObject({
      action: "login_success",
      actorUserId: ANA,
    });
  });

  it("gives the same answer for wrong code, wrong password and unknown user", async () => {
    const answers = [];
    for (const [username, password, c] of [
      ["ana", "right password", "000000"],
      ["ana", "wrong password", code()],
      ["nobody", "right password", code()],
    ] as const) {
      const t = setup();
      (t.api.authLookup as ReturnType<typeof vi.fn>).mockImplementation(
        async (u: string) => (u === "ana" ? t.user(ANA) : null),
      );
      answers.push(
        await attemptLogin(t.deps, "203.0.113.7", {
          username,
          password,
          code: c,
        }),
      );
      // argon2 runs in every case, against the dummy hash for an unknown user.
      expect(t.verifyPassword).toHaveBeenCalledTimes(1);
    }
    expect(answers).toEqual([
      { ok: false, status: 400, message: GENERIC_ERROR },
      { ok: false, status: 400, message: GENERIC_ERROR },
      { ok: false, status: 400, message: GENERIC_ERROR },
    ]);
  });

  it("never sends an unknown username to the audit log", async () => {
    const t = setup();
    await attemptLogin(t.deps, "203.0.113.7", {
      username: "my-password-typed-here",
      password: "x",
      code: "1",
    });
    expect(JSON.stringify(t.audits)).not.toContain("my-password-typed-here");
    expect(t.audits[0]).toMatchObject({
      action: "login_failure",
      actorUserId: null,
      detail: { reason: "unknown_user" },
    });
  });

  it.each([
    ["inactive", { active: false }],
    ["no password", { passwordHash: null }],
    ["no 2FA", { totpSecretEnc: null }],
  ])("refuses an active-looking user with %s", async (_, extra) => {
    const t = setup();
    (t.api.authLookup as ReturnType<typeof vi.fn>).mockResolvedValue(
      t.user(ANA, extra),
    );
    const result = await attemptLogin(t.deps, "203.0.113.7", {
      username: "ana",
      password: "right password",
      code: code(),
    });
    expect(result).toEqual({ ok: false, status: 400, message: GENERIC_ERROR });
  });

  it("refuses a code that was already used", async () => {
    const t = setup();
    (t.api.authLookup as ReturnType<typeof vi.fn>).mockResolvedValue(
      t.user(ANA),
    );
    const input = { username: "ana", password: "right password", code: code() };
    expect((await attemptLogin(t.deps, "203.0.113.7", input)).ok).toBe(true);
    expect(await attemptLogin(t.deps, "203.0.113.7", input)).toMatchObject({
      ok: false,
      message: GENERIC_ERROR,
    });
    expect(t.audits.at(-1)).toMatchObject({
      detail: { reason: "code_reused" },
    });
  });

  it("accepts the previous and next step, refuses two steps away", async () => {
    for (const [offset, ok] of [
      [-1, true],
      [1, true],
      [-2, false],
      [2, false],
    ] as const) {
      const t = setup();
      (t.api.authLookup as ReturnType<typeof vi.fn>).mockResolvedValue(
        t.user(ANA),
      );
      const result = await attemptLogin(t.deps, "203.0.113.7", {
        username: "ana",
        password: "right password",
        code: code(stepAt(NOW) + offset),
      });
      expect(result.ok).toBe(ok);
    }
  });

  it("fails to decrypt another user's secret pasted into the row (AAD)", async () => {
    const t = setup();
    const bobSecret = t.user(BOB).totpSecretEnc;
    (t.api.authLookup as ReturnType<typeof vi.fn>).mockResolvedValue(
      t.user(ANA, { totpSecretEnc: bobSecret }),
    );
    const result = await attemptLogin(t.deps, "203.0.113.7", {
      username: "ana",
      password: "right password",
      code: code(),
    });
    expect(result).toMatchObject({ ok: false, message: GENERIC_ERROR });
    expect(t.audits.at(-1)).toMatchObject({
      detail: { reason: "decrypt_failed" },
    });
  });

  it("refuses a banned IP without argon2 and without asking the API", async () => {
    const t = setup();
    addBan(t.deps.db, ipKey("203.0.113.7"), NOW, 60_000, "test");
    const result = await attemptLogin(t.deps, "203.0.113.7", {
      username: "ana",
      password: "right password",
      code: code(),
    });
    expect(result).toEqual({ ok: false, status: 429, message: BANNED_ERROR });
    expect(t.verifyPassword).not.toHaveBeenCalled();
    expect(t.api.authLookup).not.toHaveBeenCalled();
  });

  it("bans after 10 failures and audits the ban", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++)
      await attemptLogin(t.deps, "203.0.113.9", {
        username: `user${i}`,
        password: "x",
        code: "000000",
      });
    expect(t.audits.some((a) => a.action === "ip_ban")).toBe(true);
    const next = await attemptLogin(t.deps, "203.0.113.9", {
      username: "ana",
      password: "x",
      code: "1",
    });
    expect(next).toMatchObject({ status: 429 });
  });

  it("locks a username after 5 failures, from any IP, without argon2", async () => {
    const t = setup();
    (t.api.authLookup as ReturnType<typeof vi.fn>).mockResolvedValue(
      t.user(ANA),
    );
    for (let i = 0; i < 5; i++)
      await attemptLogin(t.deps, `198.51.100.${i}`, {
        username: "ana",
        password: "wrong",
        code: "000000",
      });
    expect(t.audits.some((a) => a.action === "username_lock")).toBe(true);
    t.verifyPassword.mockClear();
    const result = await attemptLogin(t.deps, "192.0.2.50", {
      username: "ana",
      password: "right password",
      code: code(),
    });
    expect(result).toEqual({ ok: false, status: 400, message: GENERIC_ERROR });
    expect(t.verifyPassword).not.toHaveBeenCalled();
    expect(
      t.deps.db
        .prepare("SELECT count(*) AS n FROM locks WHERE user_key = ?")
        .get(userKey("ana"))?.n,
    ).toBe(1);
  });
});
