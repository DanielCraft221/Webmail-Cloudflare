import { expect, type Page, test } from "@playwright/test";
import { ECHO_URL, MSG } from "../../test/fixtures/emails.ts";
import { freshIp, readyUser, totp } from "../helpers.ts";

// Firefox, in CI. The malicious email (test/fixtures/emails.ts) tries scripts, dialogs, forms,
// remote CSS, fonts and images; the three layers must stop every one of them.

const LOCAL = new Set(["localhost", "127.0.0.1"]);
let external: string[] = [];
let dialogs: string[] = [];
let consoleLines: string[] = [];

test.beforeEach(async ({ context }) => {
  external = [];
  dialogs = [];
  consoleLines = [];
  const ip = freshIp();
  // context.route sees every request: the page, the iframe and any new tab. A request that
  // reaches here for a host other than localhost is a failure; the CSP should stop it before.
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!LOCAL.has(url.hostname)) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": ip },
    });
  });
  context.on("page", (page) => {
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    page.on("console", (msg) =>
      consoleLines.push(`console.${msg.type()}: ${msg.text()}`),
    );
  });
});

test.afterEach(async ({ page: _page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  console.log(
    [
      `--- ${testInfo.title}`,
      `external requests: ${external.join(", ") || "(none)"}`,
      `dialogs: ${dialogs.join(", ") || "(none)"}`,
      ...consoleLines.slice(-20),
    ].join("\n"),
  );
});

async function login(page: Page, request: Parameters<typeof readyUser>[0]) {
  const user = await readyUser(request, `browser-reader-${Date.now()}`);
  await page.goto("/login");
  await page.getByLabel("Usuário").fill(user.username);
  await page.getByLabel("Senha").fill(user.password);
  await page.getByLabel("Código do aplicativo").fill(totp(user.secret, 1));
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("Conectado como")).toBeVisible();
}

test("the malicious email: no dialog, no request outside localhost, iframe cut off from the page", async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.goto(`/mensagens/${MSG.malicious}`);
  const frame = page.frameLocator('iframe[title="Conteúdo da mensagem"]');
  await expect(
    frame.getByText("Olá, esta é uma mensagem de teste."),
  ).toBeVisible();
  await expect(
    frame.getByText("Imagens remotas bloqueadas (2)."),
  ).toBeVisible();
  // Room for anything delayed: the meta refresh, fonts, background images.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_000);

  expect(dialogs).toEqual([]);
  expect(external).toEqual([]);
  // Opaque origin both ways: the page cannot read the iframe, so the iframe cannot read the page.
  expect(
    await page.evaluate(
      () =>
        (document.querySelector("iframe") as HTMLIFrameElement)
          .contentDocument === null,
    ),
  ).toBe(true);
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-popups allow-popups-to-escape-sandbox",
  );
  await expect(page).toHaveURL(new RegExp(`/mensagens/${MSG.malicious}$`));
});

test("the body route opened directly is sandboxed too (CSP sandbox)", async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.goto(`/mensagens/${MSG.malicious}/corpo`);
  await expect(
    page.getByText("Olá, esta é uma mensagem de teste."),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_000);
  expect(dialogs).toEqual([]);
  expect(external).toEqual([]);
  // The CSP's sandbox gives the document an opaque origin: no cookie, no storage of the webmail.
  expect(await page.evaluate(() => window.origin)).toBe("null");
  expect(
    await page.evaluate(() => {
      try {
        void document.cookie;
        return "readable";
      } catch {
        return "blocked";
      }
    }),
  ).toBe("blocked");
});

test("a link in the email opens a new tab, without Referer and without opener", async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.goto(`/mensagens/${MSG.malicious}`);
  const frame = page.frameLocator('iframe[title="Conteúdo da mensagem"]');
  const [tab] = await Promise.all([
    page.context().waitForEvent("page"),
    frame.getByRole("link", { name: "link normal" }).click(),
  ]);
  await tab.waitForLoadState();
  expect(tab.url()).toBe(ECHO_URL);
  await expect(tab.locator("body")).toHaveText("referer=(none)");
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  // The webmail stays where it was.
  await expect(page).toHaveURL(new RegExp(`/mensagens/${MSG.malicious}$`));
});
