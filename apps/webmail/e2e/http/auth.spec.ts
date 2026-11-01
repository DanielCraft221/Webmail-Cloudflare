import { expect, test } from "@playwright/test";
import {
  auditEvents,
  completeLink,
  completeOnWorker,
  freshIp,
  GENERIC,
  get,
  post,
  readyUser,
  remember,
  resetUser,
  sessionCookie,
  setActive,
  totp,
} from "../helpers.ts";

test("setup link, login, home and logout", async ({ request }) => {
  const user = await readyUser(request, "e2e-flow");
  const ip = freshIp();
  const code = totp(user.secret, 1);
  remember(code);
  const login = await post(
    request,
    "/login",
    { username: "E2E-Flow", password: user.password, code },
    ip,
  );
  expect(login.status()).toBe(303);
  expect(login.headers().location).toBe("/");

  // __Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain.
  const setCookie = login.headers()["set-cookie"] ?? "";
  expect(setCookie).toMatch(/^__Host-webmail_session=[A-Za-z0-9_-]{43};/);
  expect(setCookie).toMatch(/; HttpOnly/i);
  expect(setCookie).toMatch(/; Secure/i);
  expect(setCookie).toMatch(/; SameSite=Lax/i);
  expect(setCookie).toMatch(/; Path=\//i);
  expect(setCookie).not.toMatch(/Domain=/i);
  const cookie = sessionCookie(setCookie);

  const home = await get(request, "/", ip, cookie);
  expect(home.status()).toBe(200);
  expect(await home.text()).toContain("Conectado como");

  const logout = await post(request, "/logout", {}, ip, undefined, cookie);
  expect(logout.status()).toBe(303);
  expect((await get(request, "/", ip, cookie)).headers().location).toBe(
    "/login",
  );

  const actions = (await auditEvents(request)).map((e) => e.action);
  expect(actions).toEqual(
    expect.arrayContaining(["setup_complete", "login_success", "logout"]),
  );
});

test("wrong code, wrong password and unknown user get the same answer", async ({
  request,
}) => {
  const user = await readyUser(request, "e2e-same");
  const bodies: string[] = [];
  for (const form of [
    { username: user.username, password: user.password, code: "000000" },
    {
      username: user.username,
      password: "wrong password!",
      code: totp(user.secret, 1),
    },
    {
      username: "nobody-here",
      password: user.password,
      code: totp(user.secret, 1),
    },
  ]) {
    remember(form.password, form.code);
    const res = await post(request, "/login", form, freshIp());
    expect(res.status()).toBe(400);
    const html = await res.text();
    expect(html).toContain(GENERIC);
    // Same page apart from the echoed username (field and page data) and the CSP nonce.
    bodies.push(
      html
        .replace(/value="[^"]*"|username:"[^"]*"/g, "")
        .replace(/nonce-[^']+|nonce="[^"]+"/g, ""),
    );
  }
  expect(new Set(bodies).size).toBe(1);
});

test("a code that was already used is refused", async ({ request }) => {
  const user = await readyUser(request, "e2e-reuse");
  const code = totp(user.secret, 1);
  remember(code);
  const form = { username: user.username, password: user.password, code };
  expect((await post(request, "/login", form, freshIp())).status()).toBe(303);
  expect((await post(request, "/login", form, freshIp())).status()).toBe(400);
  const last = (await auditEvents(request)).find(
    (e) => e.action === "login_failure",
  );
  expect(last?.detail).toEqual({ reason: "code_reused" });
});

test("an active user without password or 2FA cannot log in", async ({
  request,
}) => {
  const { createUser } = await import("../helpers.ts");
  await createUser(request, "e2e-pending");
  const res = await post(
    request,
    "/login",
    { username: "e2e-pending", password: "anything at all", code: "123456" },
    freshIp(),
  );
  expect(res.status()).toBe(400);
  expect(await res.text()).toContain(GENERIC);
});

test("a user disabled after login loses the session on the next check", async ({
  request,
}) => {
  const user = await readyUser(request, "e2e-disabled");
  const ip = freshIp();
  const code = totp(user.secret, 1);
  remember(code);
  const login = await post(
    request,
    "/login",
    { username: user.username, password: user.password, code },
    ip,
  );
  const cookie = sessionCookie(login.headers()["set-cookie"]);
  await setActive(request, user.id, false);
  const home = await get(request, "/", ip, cookie);
  expect(home.status()).toBe(303);
  expect(home.headers().location).toBe("/login");
  // The session is gone, not just hidden.
  await setActive(request, user.id, true);
  expect((await get(request, "/", ip, cookie)).headers().location).toBe(
    "/login",
  );
});

test("a reset and a new setup drop the old session; the new secret logs in", async ({
  request,
}) => {
  const user = await readyUser(request, "e2e-reset");
  const ip = freshIp();
  const code = totp(user.secret, 1);
  remember(code);
  const login = await post(
    request,
    "/login",
    { username: user.username, password: user.password, code },
    ip,
  );
  const stolen = sessionCookie(login.headers()["set-cookie"]);
  // Reset and setup again before the webmail checks the session: /v1/me answers 200 again.
  const secret = await completeLink(
    request,
    await resetUser(request, user.id),
    user.password,
  );
  const home = await get(request, "/", ip, stolen);
  expect(home.status()).toBe(303);
  expect(home.headers().location).toBe("/login");
  // A login after the new setup keeps working.
  const fresh = totp(secret, 1);
  remember(fresh);
  const again = await post(
    request,
    "/login",
    { username: user.username, password: user.password, code: fresh },
    ip,
  );
  const cookie = sessionCookie(again.headers()["set-cookie"]);
  expect((await get(request, "/", ip, cookie)).status()).toBe(200);
});

test("on the next check, sessions created before the user's last change are dropped", async ({
  request,
}) => {
  const user = await readyUser(request, "e2e-changed");
  const ip = freshIp();
  const code = totp(user.secret, 1);
  remember(code);
  const login = await post(
    request,
    "/login",
    { username: user.username, password: user.password, code },
    ip,
  );
  const stolen = sessionCookie(login.headers()["set-cookie"]);
  // Reset and setup done without this webmail: /v1/me answers 200, only updatedAt moved.
  await completeOnWorker(request, await resetUser(request, user.id));
  const home = await get(request, "/", ip, stolen);
  expect(home.status()).toBe(303);
  expect(home.headers().location).toBe("/login");
});
