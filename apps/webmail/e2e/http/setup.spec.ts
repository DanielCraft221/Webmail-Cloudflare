import { expect, test } from "@playwright/test";
import {
  createUser,
  freshIp,
  get,
  post,
  readyUser,
  remember,
  secretFrom,
  totp,
} from "../helpers.ts";

const INVALID = "Este link de configuração não vale mais";

test("an unknown, malformed or used link is refused", async ({ request }) => {
  expect(
    await (
      await get(
        request,
        "/setup/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        freshIp(),
      )
    ).text(),
  ).toContain(INVALID);
  expect(
    await (await get(request, "/setup/short", freshIp())).text(),
  ).toContain(INVALID);
  const user = await readyUser(request, "e2e-used-link");
  expect(
    await (await get(request, `/setup/${user.token}`, freshIp())).text(),
  ).toContain(INVALID);
});

test("the QR code is a data: image from our own server", async ({
  request,
}) => {
  const { token } = await createUser(request, "e2e-qr");
  const html = await (await get(request, `/setup/${token}`, freshIp())).text();
  expect(html).toMatch(
    /<img src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+"/,
  );
  expect(html).not.toMatch(/https?:\/\/[^"]*(qr|chart)/i);
});

test("setup refuses a short password and a wrong code, keeping the link", async ({
  request,
}) => {
  const ip = freshIp();
  const { token } = await createUser(request, "e2e-setup-rules");
  const secret = secretFrom(
    await (await get(request, `/setup/${token}`, ip)).text(),
  );
  const code = totp(secret);
  remember(secret, code, "short", "a long enough password");
  const short = await post(
    request,
    `/setup/${token}`,
    { password: "short", confirm: "short", code },
    ip,
  );
  expect(short.status()).toBe(400);
  expect(await short.text()).toContain("pelo menos 12");
  const bad = await post(
    request,
    `/setup/${token}`,
    {
      password: "a long enough password",
      confirm: "a long enough password",
      code: "000000",
    },
    ip,
  );
  expect(bad.status()).toBe(400);
  const ok = await post(
    request,
    `/setup/${token}`,
    {
      password: "a long enough password",
      confirm: "a long enough password",
      code,
    },
    ip,
  );
  expect(ok.status()).toBe(303);
  expect(ok.headers().location).toBe("/login?configurado");
});

test("the setup page has a per-IP rate limit", async ({ request }) => {
  const ip = freshIp();
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++)
    statuses.push(
      (await get(request, `/setup/${"B".repeat(43)}`, ip)).status(),
    );
  // Invalid links also count as failures, so the IP ban (10) comes first.
  expect(statuses.at(-1)).toBe(429);
  expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
});
