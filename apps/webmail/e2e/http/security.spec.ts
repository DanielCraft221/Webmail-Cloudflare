import { spawnSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { APP_ENV } from "../../playwright.config.ts";
import { BASE, freshIp, get, post } from "../helpers.ts";

test("a form POST from another origin is refused (CSRF)", async ({
  request,
}) => {
  const form = { username: "a", password: "b", code: "1" };
  expect(
    (
      await post(request, "/login", form, freshIp(), "https://evil.example")
    ).status(),
  ).toBe(403);
  expect(
    (
      await post(request, "/logout", {}, freshIp(), "https://evil.example")
    ).status(),
  ).toBe(403);
  expect(
    (await post(request, "/setup/xxx", form, freshIp(), "null")).status(),
  ).toBe(403);
});

test("production without a valid CF-Connecting-IP answers 400", async ({
  request,
}) => {
  expect((await request.get("/login")).status()).toBe(400);
  expect(
    (
      await request.get("/login", {
        headers: { "CF-Connecting-IP": "not-an-ip" },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.get("/login", {
        headers: { "CF-Connecting-IP": "1.2.3.4, 5.6.7.8" },
      })
    ).status(),
  ).toBe(400);
});

test("logout only accepts POST", async ({ request }) => {
  expect((await get(request, "/logout", freshIp())).status()).toBe(405);
});

const pages = [
  "/login",
  "/",
  "/setup/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "/does-not-exist",
  "/logout",
];
for (const path of pages) {
  test(`security headers on ${path}`, async ({ request }) => {
    const res = await get(request, path, freshIp());
    const h = res.headers();
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["cache-control"]).toBe("no-store");
    expect(h["strict-transport-security"]).toMatch(/max-age=\d+/);
    const csp = h["content-security-policy"] ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    if (res.status() === 200) {
      for (const d of [
        "default-src 'self'",
        "img-src 'self' data:",
        "object-src 'none'",
      ])
        expect(csp).toContain(d);
      expect(csp).not.toContain("unsafe-inline");
    }
  });
}

test("the 400 for a missing IP also carries the headers", async ({
  request,
}) => {
  const h = (await request.get(`${BASE}/login`)).headers();
  expect(h["content-security-policy"]).toContain("default-src 'none'");
  expect(h["x-content-type-options"]).toBe("nosniff");
});

test("in production the app does not start without trusting CF-Connecting-IP", () => {
  const { ADDRESS_HEADER: _, ...env } = APP_ENV;
  const result = spawnSync(process.execPath, ["build"], {
    env: { ...env, PATH: process.env.PATH, PORT: "4199" },
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.status).not.toBe(0);
  expect(result.status).not.toBeNull(); // exited by itself, not killed by the timeout
  expect(result.stderr).toContain("ADDRESS_HEADER must be cf-connecting-ip");
});
