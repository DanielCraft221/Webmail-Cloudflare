import { env } from "cloudflare:workers";
import { api as schema } from "@webmail/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/hash";
import { addTestUsers, call, DANIEL, INACTIVE } from "./api-helpers";
import { reset } from "./helpers";

const PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGg";
const OTHER_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$b3RoZXJzYWx0b3RoZXJz$b3RoZXJoYXNob3RoZXJoYXNob3RoZXJoYXNoaGg";
const TOTP_ENC = "v1.aXZpdml2aXZpdml2.Y2lwaGVydGV4dGNpcGhlcnRleHQ";

type Json = Record<string, unknown>;
type CallOptions = NonNullable<Parameters<typeof call>[1]>;

/** Admin token, no X-Webmail-User: how the CLI calls. */
function admin(path: string, options: CallOptions = {}) {
  return call(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
      "X-Webmail-User": null,
      "CF-Connecting-IP": "203.0.113.7",
      ...options.headers,
    },
  });
}

/** Internal token, no X-Webmail-User: how the webmail calls before anyone is logged in. */
function service(path: string, body: unknown, headers = {}) {
  return call(path, {
    method: "POST",
    body,
    headers: { "X-Webmail-User": null, ...headers },
  });
}

let tokenCounter = 0;
/** A fresh setup token and its hash, as the CLI makes them. */
async function setupToken(): Promise<{ token: string; hash: string }> {
  tokenCounter += 1;
  const token = `setup-token-${tokenCounter}-${crypto.randomUUID()}`;
  return { token, hash: await sha256Hex(token) };
}

async function createUser(
  username: string,
  extra: Json = {},
): Promise<{ id: string; hash: string }> {
  const { hash } = await setupToken();
  const response = await admin("/v1/admin/users", {
    method: "POST",
    body: { username, setupTokenHash: hash, ...extra },
  });
  expect(response.status).toBe(201);
  const user = (await response.json()) as Json;
  return { id: user.id as string, hash };
}

async function auditRows() {
  const { results } = await env.DB.prepare(
    "SELECT source, actor_user_id, action, target, ip, detail FROM audit_log ORDER BY id",
  ).all<Json>();
  return results;
}

beforeEach(async () => {
  await reset();
  await addTestUsers();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM audit_log"),
    env.DB.prepare("DELETE FROM users WHERE username LIKE 't-%'"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("token separation", () => {
  const adminRoutes: [string, string, unknown?][] = [
    ["GET", "/v1/admin/users"],
    [
      "POST",
      "/v1/admin/users",
      { username: "t-x", setupTokenHash: "a".repeat(64) },
    ],
    [
      "POST",
      `/v1/admin/users/${DANIEL}/reset`,
      { setupTokenHash: "a".repeat(64) },
    ],
    ["PATCH", `/v1/admin/users/${DANIEL}`, { active: false }],
    ["GET", "/v1/admin/audit"],
    ["POST", "/v1/admin/audit", { action: "ip_unban" }],
  ];

  it.each(adminRoutes)(
    "INTERNAL_API_TOKEN on %s %s answers 401",
    async (method, path, body) => {
      for (const user of [null, DANIEL]) {
        const response = await call(path, {
          method,
          body,
          headers: { "X-Webmail-User": user },
        });
        expect(response.status).toBe(401);
      }
      const daniel = await env.DB.prepare(
        "SELECT active FROM users WHERE id = ?1",
      )
        .bind(DANIEL)
        .first<{ active: number }>();
      expect(daniel?.active).toBe(1);
      expect(await auditRows()).toEqual([]);
    },
  );

  it.each([
    ["GET", "/v1/mailboxes", undefined],
    ["GET", "/v1/me", undefined],
    ["POST", "/v1/search", { q: "teste" }],
    ["POST", "/v1/auth/lookup", { username: "danielcraft221" }],
    ["POST", "/v1/auth/setup/lookup", { tokenHash: "a".repeat(64) }],
    ["POST", "/v1/audit", { action: "logout" }],
  ])("ADMIN_API_TOKEN on %s %s answers 401", async (method, path, body) => {
    for (const user of [null, DANIEL]) {
      const response = await call(path, {
        method,
        body,
        headers: {
          Authorization: `Bearer ${env.ADMIN_API_TOKEN}`,
          "X-Webmail-User": user,
        },
      });
      expect(response.status).toBe(401);
    }
  });

  it.each([
    "/v1/%61dmin/users",
    "/v1//admin/users",
    "/v1/admin/users/",
    "/V1/ADMIN/USERS",
  ])("the internal token never lists users through %s", async (path) => {
    for (const user of [null, DANIEL]) {
      const response = await call(path, {
        headers: { "X-Webmail-User": user },
      });
      expect(response.status).not.toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain("users");
    }
  });

  it("fails closed without ADMIN_API_TOKEN", async () => {
    const response = await admin("/v1/admin/users", {
      env: { ...env, ADMIN_API_TOKEN: undefined },
      headers: { Authorization: "Bearer undefined" },
    });
    expect(response.status).toBe(401);
  });

  it("still requires the Access JWT on admin routes", async () => {
    const response = await admin("/v1/admin/users", {
      headers: { "Cf-Access-Jwt-Assertion": null },
    });
    expect(response.status).toBe(401);
  });

  it("limits admin and service routes by a fixed key", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const limited = { ...env, API_RATE_LIMIT: { limit } as RateLimit };
    expect((await admin("/v1/admin/users", { env: limited })).status).toBe(429);
    const lookup = await call("/v1/auth/lookup", {
      method: "POST",
      body: { username: "danielcraft221" },
      headers: { "X-Webmail-User": null },
      env: limited,
    });
    expect(lookup.status).toBe(429);
    expect(limit.mock.calls).toEqual([
      [{ key: "admin" }],
      [{ key: "service" }],
    ]);
  });
});

describe("POST /v1/auth/lookup", () => {
  it("returns the login data, with nulls while setup is pending", async () => {
    await env.DB.prepare(
      "UPDATE users SET password_hash = NULL, totp_secret_enc = NULL WHERE id = ?1",
    )
      .bind(DANIEL)
      .run();
    const response = await service("/v1/auth/lookup", {
      username: "danielcraft221",
    });
    expect(response.status).toBe(200);
    const body = schema.authLookupResponse.parse(await response.json());
    expect(body).toEqual({
      id: DANIEL,
      active: true,
      role: "admin",
      passwordHash: null,
      totpSecretEnc: null,
    });
  });

  it("reports an inactive user as inactive", async () => {
    const body = (await (
      await service("/v1/auth/lookup", { username: "inativo" })
    ).json()) as Json;
    expect(body).toMatchObject({ id: INACTIVE, active: false });
  });

  it("answers an unknown user with a generic 404", async () => {
    const response = await service("/v1/auth/lookup", { username: "ninguem" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it.each([
    [{}],
    [{ username: "Daniel" }],
    [{ username: "a b" }],
    [{ username: "danielcraft221", extra: 1 }],
    ["not json"],
  ])("refuses a malformed body %j", async (body) => {
    expect((await service("/v1/auth/lookup", body)).status).toBe(400);
  });
});

describe("setup link", () => {
  async function complete(tokenHash: string, passwordHash = PASSWORD_HASH) {
    return service("/v1/auth/setup/complete", {
      tokenHash,
      passwordHash,
      totpSecretEnc: TOTP_ENC,
    });
  }

  it("looks up, completes once and then is gone", async () => {
    const { id, hash } = await createUser("t-ana");
    const lookup = await service("/v1/auth/setup/lookup", { tokenHash: hash });
    expect(lookup.status).toBe(200);
    expect(schema.setupUserResponse.parse(await lookup.json())).toEqual({
      id,
      username: "t-ana",
    });

    const done = await complete(hash);
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ id, username: "t-ana" });
    const login = (await (
      await service("/v1/auth/lookup", { username: "t-ana" })
    ).json()) as Json;
    expect(login).toMatchObject({
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
    });

    expect(
      (await service("/v1/auth/setup/lookup", { tokenHash: hash })).status,
    ).toBe(404);
    expect((await complete(hash)).status).toBe(404);
    const row = await env.DB.prepare(
      "SELECT setup_token_hash, setup_expires_at FROM users WHERE id = ?1",
    )
      .bind(id)
      .first();
    expect(row).toEqual({ setup_token_hash: null, setup_expires_at: null });
  });

  it("refuses an expired link with 404", async () => {
    const { id, hash } = await createUser("t-expirado");
    await env.DB.prepare(
      "UPDATE users SET setup_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE id = ?1",
    )
      .bind(id)
      .run();
    expect(
      (await service("/v1/auth/setup/lookup", { tokenHash: hash })).status,
    ).toBe(404);
    expect((await complete(hash)).status).toBe(404);
  });

  it("refuses a nonexistent link with 404", async () => {
    const { hash } = await setupToken();
    expect(
      (await service("/v1/auth/setup/lookup", { tokenHash: hash })).status,
    ).toBe(404);
    expect((await complete(hash)).status).toBe(404);
  });

  it("refuses the link of an inactive user", async () => {
    const { id, hash } = await createUser("t-desativado");
    await admin(`/v1/admin/users/${id}`, {
      method: "PATCH",
      body: { active: false },
    });
    expect(
      (await service("/v1/auth/setup/lookup", { tokenHash: hash })).status,
    ).toBe(404);
    expect((await complete(hash)).status).toBe(404);
  });

  it("lets only one of two concurrent completions write", async () => {
    const { id, hash } = await createUser("t-corrida");
    const responses = await Promise.all([
      complete(hash, PASSWORD_HASH),
      complete(hash, OTHER_PASSWORD_HASH),
    ]);
    const statuses = responses.map((r) => r.status);
    expect([...statuses].sort()).toEqual([200, 404]);
    const winner = statuses[0] === 200 ? PASSWORD_HASH : OTHER_PASSWORD_HASH;
    const row = await env.DB.prepare(
      "SELECT password_hash FROM users WHERE id = ?1",
    )
      .bind(id)
      .first<{ password_hash: string }>();
    expect(row?.password_hash).toBe(winner);
  });

  it.each([
    [{ passwordHash: "plain-password" }],
    [{ passwordHash: "$argon2i$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA" }],
    [{ totpSecretEnc: "JBSWY3DPEHPK3PXP" }],
    [{ tokenHash: "A".repeat(64) }],
  ])("refuses malformed values %j", async (override) => {
    const { hash } = await createUser("t-formato");
    const response = await service("/v1/auth/setup/complete", {
      tokenHash: hash,
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
      ...override,
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /v1/me", () => {
  it("returns the session user", async () => {
    await env.DB.prepare("UPDATE users SET updated_at = ?2 WHERE id = ?1")
      .bind(DANIEL, "2026-11-01T12:00:00.000Z")
      .run();
    const response = await call("/v1/me");
    expect(schema.meResponse.parse(await response.json())).toEqual({
      id: DANIEL,
      username: "danielcraft221",
      displayName: "Daniel",
      role: "admin",
      updatedAt: "2026-11-01T12:00:00.000Z",
    });
  });

  it("closes every user route after a reset, until setup is done again", async () => {
    const { id, hash } = await createUser("t-reset");
    const complete = (tokenHash: string) =>
      service("/v1/auth/setup/complete", {
        tokenHash,
        passwordHash: PASSWORD_HASH,
        totpSecretEnc: TOTP_ENC,
      });
    expect((await call("/v1/me", { user: id })).status).toBe(401);
    expect((await complete(hash)).status).toBe(200);
    expect((await call("/v1/me", { user: id })).status).toBe(200);

    const next = await setupToken();
    await admin(`/v1/admin/users/${id}/reset`, {
      method: "POST",
      body: { setupTokenHash: next.hash },
    });
    expect((await call("/v1/me", { user: id })).status).toBe(401);
    expect((await call("/v1/mailboxes", { user: id })).status).toBe(401);
    expect((await complete(next.hash)).status).toBe(200);
    expect((await call("/v1/me", { user: id })).status).toBe(200);
  });

  it.each([["password_hash"], ["totp_secret_enc"]])(
    "answers 401 when only %s is missing",
    async (column) => {
      await env.DB.prepare(`UPDATE users SET ${column} = NULL WHERE id = ?1`)
        .bind(DANIEL)
        .run();
      expect((await call("/v1/me")).status).toBe(401);
      expect((await call("/v1/mailboxes")).status).toBe(401);
    },
  );

  it("returns updatedAt, moved forward by setup, PATCH and reset", async () => {
    const { id, hash } = await createUser("t-mudancas");
    const stored = async () =>
      (
        await env.DB.prepare("SELECT updated_at FROM users WHERE id = ?1")
          .bind(id)
          .first<{ updated_at: string }>()
      )?.updated_at ?? "";
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const seen = [await stored()];
    await tick();
    await service("/v1/auth/setup/complete", {
      tokenHash: hash,
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
    });
    seen.push(await stored());
    const me = schema.meResponse.parse(
      await (await call("/v1/me", { user: id })).json(),
    );
    expect(me.updatedAt).toBe(seen.at(-1));
    await tick();
    await admin(`/v1/admin/users/${id}`, {
      method: "PATCH",
      body: { displayName: "Outro nome" },
    });
    seen.push(await stored());
    await tick();
    await admin(`/v1/admin/users/${id}/reset`, {
      method: "POST",
      body: { setupTokenHash: (await setupToken()).hash },
    });
    seen.push(await stored());
    for (let i = 1; i < seen.length; i++)
      expect(Date.parse(seen[i] ?? "")).toBeGreaterThan(
        Date.parse(seen[i - 1] ?? ""),
      );
  });

  it("answers 401 once the user is disabled", async () => {
    const { id, hash } = await createUser("t-sessao");
    await service("/v1/auth/setup/complete", {
      tokenHash: hash,
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
    });
    expect((await call("/v1/me", { user: id })).status).toBe(200);
    await admin(`/v1/admin/users/${id}`, {
      method: "PATCH",
      body: { active: false },
    });
    expect((await call("/v1/me", { user: id })).status).toBe(401);
  });
});

describe("POST /v1/audit", () => {
  it("records a webmail event; an unknown actor becomes NULL", async () => {
    expect(
      (
        await service("/v1/audit", {
          action: "login_success",
          actorUserId: DANIEL,
          ip: "2001:db8::1",
          detail: { reason: "ok" },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await service("/v1/audit", {
          action: "login_failure",
          actorUserId: "00000000-0000-4000-8000-0000000000ff",
          ip: "198.51.100.2",
          detail: { reason: "unknown_user" },
        })
      ).status,
    ).toBe(204);
    expect(await auditRows()).toEqual([
      {
        source: "webmail",
        actor_user_id: DANIEL,
        action: "login_success",
        target: null,
        ip: "2001:db8::1",
        detail: '{"reason":"ok"}',
      },
      {
        source: "webmail",
        actor_user_id: null,
        action: "login_failure",
        target: null,
        ip: "198.51.100.2",
        detail: '{"reason":"unknown_user"}',
      },
    ]);
  });

  it.each([
    [{ action: "user_create" }],
    [{ action: "ip_unban" }],
    [{ action: "logout", source: "cli" }],
    [{ action: "logout", ip: "not-an-ip" }],
    [{ action: "logout", detail: { nested: { a: 1 } } }],
    [{ action: "logout", detail: { big: "x".repeat(101) } }],
    [{ action: "logout", target: "\u001b[2Jforjado" }],
    [{ action: "logout", detail: { ua: "a\u202eb" } }],
    [
      {
        action: "logout",
        detail: Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [`k${i}`, i]),
        ),
      },
    ],
  ])("refuses %j", async (body) => {
    expect((await service("/v1/audit", body)).status).toBe(400);
    expect(await auditRows()).toEqual([]);
  });
});

describe("admin users", () => {
  const SECRET_KEYS = [
    "passwordHash",
    "totpSecretEnc",
    "setupTokenHash",
    "tokenHash",
  ];

  function expectNoSecrets(text: string, ...values: string[]) {
    for (const key of SECRET_KEYS) expect(text).not.toContain(key);
    for (const value of [PASSWORD_HASH, TOTP_ENC, ...values])
      expect(text).not.toContain(value);
  }

  it("creates a user and refuses a duplicate username", async () => {
    const { hash } = await setupToken();
    const response = await admin("/v1/admin/users", {
      method: "POST",
      body: {
        username: "t-bia",
        role: "user",
        displayName: "Bia",
        setupTokenHash: hash,
      },
    });
    expect(response.status).toBe(201);
    const text = await response.text();
    expectNoSecrets(text, hash);
    const user = JSON.parse(text) as Json;
    expect(user).toMatchObject({
      username: "t-bia",
      displayName: "Bia",
      role: "user",
      active: true,
      hasPassword: false,
      hasTotp: false,
    });
    const expires = Date.parse(user.setupExpiresAt as string) - Date.now();
    expect(expires).toBeGreaterThan(23.9 * 3600_000);
    expect(expires).toBeLessThanOrEqual(24 * 3600_000);

    const again = await admin("/v1/admin/users", {
      method: "POST",
      body: { username: "t-bia", setupTokenHash: (await setupToken()).hash },
    });
    expect(again.status).toBe(409);
    expect(await auditRows()).toEqual([
      {
        source: "cli",
        actor_user_id: null,
        action: "user_create",
        target: user.id,
        ip: "203.0.113.7",
        detail: '{"username":"t-bia","role":"user"}',
      },
    ]);
  });

  it("lists users without hash, secret or token", async () => {
    const { hash } = await createUser("t-lista");
    await service("/v1/auth/setup/complete", {
      tokenHash: hash,
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
    });
    const pending = await createUser("t-pendente");
    const response = await admin("/v1/admin/users");
    const text = await response.text();
    expectNoSecrets(text, hash, pending.hash);
    const users = (JSON.parse(text) as { users: Json[] }).users;
    expect(users.find((u) => u.username === "t-lista")).toMatchObject({
      hasPassword: true,
      hasTotp: true,
      setupExpiresAt: null,
    });
    expect(
      users.find((u) => u.username === "t-pendente")?.setupExpiresAt,
    ).toEqual(expect.any(String));
    expect((await auditRows()).at(-1)).toMatchObject({ action: "user_list" });
  });

  it("reset clears password and 2FA and makes a new link", async () => {
    const first = await createUser("t-reset");
    await service("/v1/auth/setup/complete", {
      tokenHash: first.hash,
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
    });
    const { hash } = await setupToken();
    const response = await admin(`/v1/admin/users/${first.id}/reset`, {
      method: "POST",
      body: { setupTokenHash: hash },
    });
    expect(response.status).toBe(200);
    expectNoSecrets(await response.text(), hash);
    const login = (await (
      await service("/v1/auth/lookup", { username: "t-reset" })
    ).json()) as Json;
    expect(login).toMatchObject({ passwordHash: null, totpSecretEnc: null });
    expect(
      (await service("/v1/auth/setup/lookup", { tokenHash: hash })).status,
    ).toBe(200);
    expect((await auditRows()).at(-1)).toMatchObject({
      action: "user_reset",
      target: first.id,
    });
  });

  it("reset and patch of an unknown user answer 404 and record nothing", async () => {
    const missing = "00000000-0000-4000-8000-0000000000ff";
    const reset = await admin(`/v1/admin/users/${missing}/reset`, {
      method: "POST",
      body: { setupTokenHash: (await setupToken()).hash },
    });
    expect(reset.status).toBe(404);
    const patch = await admin(`/v1/admin/users/${missing}`, {
      method: "PATCH",
      body: { role: "user" },
    });
    expect(patch.status).toBe(404);
    expect(
      (
        await admin("/v1/admin/users/not-a-uuid/reset", {
          method: "POST",
          body: {},
        })
      ).status,
    ).toBe(404);
    expect(await auditRows()).toEqual([]);
  });

  it("patch changes active, role and display name", async () => {
    const { id } = await createUser("t-patch", { displayName: "Antes" });
    const response = await admin(`/v1/admin/users/${id}`, {
      method: "PATCH",
      body: { active: false, role: "admin", displayName: null },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      active: false,
      role: "admin",
      displayName: null,
    });
    const keep = await admin(`/v1/admin/users/${id}`, {
      method: "PATCH",
      body: { active: true },
    });
    expect(await keep.json()).toMatchObject({
      active: true,
      role: "admin",
      displayName: null,
    });
    expect((await auditRows()).at(-1)).toMatchObject({
      action: "user_update",
      target: id,
      detail: '{"active":true}',
    });
  });

  it.each([
    [{}],
    [{ role: "root" }],
    [{ active: "no" }],
    [{ username: "t-x" }],
    [{ displayName: "Ana\u001b[31m" }],
  ])("patch refuses %j", async (body) => {
    const { id } = await createUser("t-patch-ruim");
    const response = await admin(`/v1/admin/users/${id}`, {
      method: "PATCH",
      body,
    });
    expect(response.status).toBe(400);
  });
});

describe("admin audit", () => {
  it("lists the latest events without secrets and records the listing", async () => {
    const { hash } = await createUser("t-audit");
    await service("/v1/auth/setup/complete", {
      tokenHash: hash,
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
    });
    await service("/v1/audit", { action: "setup_complete", target: "t-audit" });
    const response = await admin("/v1/admin/audit?limit=10");
    const text = await response.text();
    for (const value of [hash, PASSWORD_HASH, TOTP_ENC])
      expect(text).not.toContain(value);
    const events = (JSON.parse(text) as { events: Json[] }).events;
    expect(events.map((e) => e.action)).toEqual([
      "setup_complete",
      "user_create",
    ]);
    expect(events[1]?.detail).toEqual({ username: "t-audit", role: "user" });
    expect((await auditRows()).at(-1)).toMatchObject({ action: "audit_list" });
  });

  it.each(["0", "501", "abc"])("refuses limit=%s", async (limit) => {
    expect((await admin(`/v1/admin/audit?limit=${limit}`)).status).toBe(400);
  });

  it("records a local CLI action with source cli, never a webmail action", async () => {
    const ok = await admin("/v1/admin/audit", {
      method: "POST",
      body: { action: "ip_unban", target: "2001:db8::/64" },
    });
    expect(ok.status).toBe(204);
    const forged = await admin("/v1/admin/audit", {
      method: "POST",
      body: { action: "login_success" },
    });
    expect(forged.status).toBe(400);
    expect(await auditRows()).toEqual([
      {
        source: "cli",
        actor_user_id: null,
        action: "ip_unban",
        target: "2001:db8::/64",
        ip: "203.0.113.7",
        detail: null,
      },
    ]);
  });
});

describe("logs of auth and admin routes", () => {
  it("never contain hashes, secrets, tokens or the Authorization header", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    const { id, hash } = await createUser("t-log");
    await service("/v1/auth/setup/lookup", { tokenHash: hash });
    await service("/v1/auth/setup/complete", {
      tokenHash: hash,
      passwordHash: PASSWORD_HASH,
      totpSecretEnc: TOTP_ENC,
    });
    await service("/v1/auth/lookup", { username: "t-log" });
    await admin(`/v1/admin/users/${id}/reset`, {
      method: "POST",
      body: { setupTokenHash: (await setupToken()).hash },
    });
    await admin("/v1/admin/users");
    await service("/v1/auth/setup/complete", {
      tokenHash: hash,
      passwordHash: "x",
    });

    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join("\n");
    for (const value of [
      hash,
      PASSWORD_HASH,
      TOTP_ENC,
      env.ADMIN_API_TOKEN ?? "",
      env.INTERNAL_API_TOKEN ?? "",
      "Bearer",
      "t-log",
    ])
      expect(text).not.toContain(value);
  });
});
