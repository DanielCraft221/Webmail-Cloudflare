import { expect, test } from "@playwright/test";
import {
  auditEvents,
  BANNED,
  freshIp,
  GENERIC,
  post,
  readyUser,
  remember,
  totp,
} from "../helpers.ts";

const wrong = (username: string) => ({
  username,
  password: "wrong password!",
  code: "000000",
});

test("10 failures from one IP ban it, even with the right password", async ({
  request,
}) => {
  const user = await readyUser(request, "e2e-ban");
  const ip = freshIp();
  for (let i = 0; i < 10; i++)
    expect(
      (await post(request, "/login", wrong(`nobody${i}`), ip)).status(),
    ).toBe(400);
  const code = totp(user.secret, 1);
  remember(code);
  const banned = await post(
    request,
    "/login",
    { username: user.username, password: user.password, code },
    ip,
  );
  expect(banned.status()).toBe(429);
  expect(await banned.text()).toContain(BANNED);
  const ban = (await auditEvents(request)).find((e) => e.action === "ip_ban");
  expect(ban?.detail).toEqual({ minutes: 15 });
  // Another IP still gets in.
  expect(
    (
      await post(
        request,
        "/login",
        { username: user.username, password: user.password, code },
        freshIp(),
      )
    ).status(),
  ).toBe(303);
});

test("two IPv6 addresses of the same /64 count together", async ({
  request,
}) => {
  for (let i = 0; i < 10; i++)
    await post(
      request,
      "/login",
      wrong(`v6user${i}`),
      `2001:db8:77:1::${i + 1}`,
    );
  const res = await post(
    request,
    "/login",
    wrong("v6user"),
    "2001:db8:77:1:abcd::99",
  );
  expect(res.status()).toBe(429);
  expect(
    (
      await post(request, "/login", wrong("v6user"), "2001:db8:77:2::1")
    ).status(),
  ).toBe(400);
});

test("5 failures on a username lock it from any IP", async ({ request }) => {
  const user = await readyUser(request, "e2e-lock");
  for (let i = 0; i < 5; i++)
    await post(request, "/login", wrong(user.username), freshIp());
  const code = totp(user.secret, 1);
  remember(code);
  const res = await post(
    request,
    "/login",
    { username: user.username, password: user.password, code },
    freshIp(),
  );
  expect(res.status()).toBe(400);
  expect(await res.text()).toContain(GENERIC);
  expect(
    (await auditEvents(request)).some((e) => e.action === "username_lock"),
  ).toBe(true);
});
