import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOCK_TOLERANCE_SECONDS } from "../src/access";
import worker from "../src/index";
import {
  accessJwt,
  addTestUsers,
  apiEnv,
  call,
  DANIEL,
  ecPrivateKey,
  FAKE_PASSWORD_HASH,
  FAKE_TOTP_ENC,
  INACTIVE,
  rsaJwk,
  validHeaders,
} from "./api-helpers";
import { reset } from "./helpers";

beforeEach(async () => {
  await reset();
  await addTestUsers();
});
afterEach(() => vi.restoreAllMocks());

const now = () => Math.floor(Date.now() / 1000);

async function withJwt(token: string | null) {
  return call("/v1/mailboxes", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}

describe("Access JWT", () => {
  it("accepts a valid token", async () => {
    expect((await withJwt(await accessJwt())).status).toBe(200);
  });

  it.each([
    ["missing", null],
    ["not a JWT", "not-a-jwt"],
  ])("refuses a %s token", async (_, token) => {
    expect((await withJwt(token)).status).toBe(401);
  });

  it("refuses algorithms other than RS256, even with a matching key in the set", async () => {
    const es256 = await accessJwt(
      {},
      { alg: "ES256", kid: "test-ec", key: ecPrivateKey },
    );
    expect((await withJwt(es256)).status).toBe(401);
    // Algorithm confusion: HMAC keyed with the public RSA key.
    const hs256 = await accessJwt(
      {},
      { alg: "HS256", key: new TextEncoder().encode(JSON.stringify(rsaJwk)) },
    );
    expect((await withJwt(hs256)).status).toBe(401);
    const [, body] = (await accessJwt()).split(".");
    const unsigned = `${btoa('{"alg":"none"}').replace(/=+$/, "")}.${body}.`;
    expect((await withJwt(unsigned)).status).toBe(401);
  });

  it("refuses a token signed by another key", async () => {
    const other = await generateKeyPair("RS256");
    expect(
      (await withJwt(await accessJwt({}, { key: other.privateKey }))).status,
    ).toBe(401);
  });

  it.each([
    ["another team", "https://other.cloudflareaccess.com"],
    ["a trailing slash", `${env.ACCESS_TEAM_DOMAIN}/`],
    ["different case", env.ACCESS_TEAM_DOMAIN?.toUpperCase()],
    ["no issuer", undefined],
  ])("refuses an issuer with %s", async (_, iss) => {
    expect((await withJwt(await accessJwt({ iss }))).status).toBe(401);
  });

  it("requires the audience to contain ACCESS_AUD", async () => {
    expect((await withJwt(await accessJwt({ aud: "other-aud" }))).status).toBe(
      401,
    );
    expect((await withJwt(await accessJwt({ aud: undefined }))).status).toBe(
      401,
    );
    expect(
      (await withJwt(await accessJwt({ aud: ["other-aud", env.ACCESS_AUD] })))
        .status,
    ).toBe(200);
  });

  it("checks exp with at most 60 s of clock tolerance", async () => {
    expect(CLOCK_TOLERANCE_SECONDS).toBe(60);
    expect((await withJwt(await accessJwt({ exp: now() - 30 }))).status).toBe(
      200,
    );
    expect((await withJwt(await accessJwt({ exp: now() - 90 }))).status).toBe(
      401,
    );
    expect((await withJwt(await accessJwt({ exp: undefined }))).status).toBe(
      401,
    );
  });

  it("checks nbf with at most 60 s of clock tolerance", async () => {
    expect((await withJwt(await accessJwt({ nbf: now() + 30 }))).status).toBe(
      200,
    );
    expect((await withJwt(await accessJwt({ nbf: now() + 90 }))).status).toBe(
      401,
    );
  });

  it("requires the common_name of the expected service token", async () => {
    expect(
      (await withJwt(await accessJwt({ common_name: "other.access" }))).status,
    ).toBe(401);
    expect(
      (await withJwt(await accessJwt({ common_name: undefined }))).status,
    ).toBe(401);
  });

  it.each(["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ACCESS_CLIENT_ID"] as const)(
    "fails closed without %s",
    async (name) => {
      const response = await call("/v1/mailboxes", {
        env: { ...apiEnv, [name]: undefined },
      });
      expect(response.status).toBe(401);
    },
  );
});

describe("Access key source in production", () => {
  async function productionFetch(teamDomain: string) {
    const headers = await validHeaders();
    headers["Cf-Access-Jwt-Assertion"] = await accessJwt({ iss: teamDomain });
    return worker.fetch(
      new Request("https://mail-api.test/v1/mailboxes", { headers }),
      { ...apiEnv, ACCESS_TEAM_DOMAIN: teamDomain },
      createExecutionContext(),
    );
  }

  function fetchedUrls(spy: { mock: { calls: Parameters<typeof fetch>[] } }) {
    return spy.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input),
    );
  }

  it("fetches keys only from the team's Access certs URL", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ keys: [rsaJwk] }));
    const response = await productionFetch(
      "https://prodcheck.cloudflareaccess.com",
    );
    expect(response.status).toBe(200);
    expect(fetchedUrls(spy)).toEqual([
      "https://prodcheck.cloudflareaccess.com/cdn-cgi/access/certs",
    ]);
  });

  it("refuses a team domain outside cloudflareaccess.com without fetching anything", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ keys: [rsaJwk] }));
    for (const team of [
      "https://evil.example.com",
      "http://webmail-test.cloudflareaccess.com",
      "https://webmail-test.cloudflareaccess.com.evil.example",
    ]) {
      expect((await productionFetch(team)).status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("bearer token", () => {
  it.each([
    ["missing", null],
    ["wrong", "Bearer wrong-token"],
    ["without the scheme", env.INTERNAL_API_TOKEN ?? ""],
    ["with another scheme", `Basic ${env.INTERNAL_API_TOKEN}`],
    ["with a suffix", `Bearer ${env.INTERNAL_API_TOKEN}x`],
  ])("refuses a %s bearer", async (_, value) => {
    const response = await call("/v1/mailboxes", {
      headers: { Authorization: value },
    });
    expect(response.status).toBe(401);
  });

  it("fails closed without INTERNAL_API_TOKEN", async () => {
    const response = await call("/v1/mailboxes", {
      env: { ...apiEnv, INTERNAL_API_TOKEN: undefined },
      headers: { Authorization: "Bearer undefined" },
    });
    expect(response.status).toBe(401);
  });
});

describe("X-Webmail-User", () => {
  it.each([
    ["missing", null],
    ["not a UUID", "danielcraft221"],
    ["unknown", "00000000-0000-4000-8000-0000000000ff"],
    ["inactive", INACTIVE],
  ])("refuses a %s user", async (_, user) => {
    const response = await call("/v1/mailboxes", {
      headers: { "X-Webmail-User": user },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

describe("rate limit", () => {
  it("limits per user id and answers 429", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const response = await call("/v1/mailboxes", {
      env: { ...apiEnv, API_RATE_LIMIT: { limit } as RateLimit },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(limit).toHaveBeenCalledWith({ key: DANIEL });
  });

  it("is not consulted before authentication", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    await call("/v1/mailboxes", {
      env: { ...apiEnv, API_RATE_LIMIT: { limit } as RateLimit },
      headers: { Authorization: null },
    });
    expect(limit).not.toHaveBeenCalled();
  });

  it("the real binding stops a user after 100 requests a minute", async () => {
    const user = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, totp_secret_enc) VALUES (?1, ?2, ?3, ?4)",
    )
      .bind(
        user,
        `limite-${user.slice(0, 8)}`,
        FAKE_PASSWORD_HASH,
        FAKE_TOTP_ENC,
      )
      .run();
    const statuses: number[] = [];
    for (let i = 0; i < 101; i++) {
      statuses.push((await call("/v1/mailboxes", { user, env })).status);
    }
    expect(statuses.slice(0, 100).every((s) => s === 200)).toBe(true);
    expect(statuses[100]).toBe(429);
  });
});
