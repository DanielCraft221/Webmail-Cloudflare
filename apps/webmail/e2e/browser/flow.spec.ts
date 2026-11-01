import { expect, test } from "@playwright/test";
import { BANNED, createUser, freshIp, GENERIC, totp } from "../helpers.ts";

// Firefox only: it accepts __Host- cookies on http://localhost (docs/webmail-auth.md).

/** What the page did, printed when a test fails: the next CI failure explains itself. */
const trail = {
  lastResponse: "",
  messages: [] as string[],
};

test.beforeEach(async ({ page }) => {
  trail.lastResponse = "";
  trail.messages = [];
  // Cloudflare's header on every request, form POSTs included: Firefox does not apply
  // page.setExtraHTTPHeaders to a form submission, and the app answers 400 without it.
  const ip = freshIp();
  await page.route("**/*", (route) =>
    route.continue({
      headers: { ...route.request().headers(), "cf-connecting-ip": ip },
    }),
  );
  page.on("response", (res) => {
    if (res.request().isNavigationRequest())
      trail.lastResponse = `${res.request().method()} ${res.url()} -> ${res.status()}`;
  });
  // CSP violations show up as console errors or warnings.
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      trail.messages.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) =>
    trail.messages.push(`pageerror: ${err.message}`),
  );
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const body = await page
    .locator("body")
    .innerText()
    .catch(() => "(no body)");
  console.log(
    [
      `--- ${testInfo.title}: what the page saw`,
      `last navigation: ${trail.lastResponse || "(none)"}`,
      `url: ${page.url()}`,
      `body: ${body.slice(0, 800)}`,
      ...(trail.messages.length ? trail.messages : ["no console errors"]),
    ].join("\n"),
  );
});

test("setup by link, login, wrong code and logout", async ({
  page,
  request,
}) => {
  const { token } = await createUser(request, "browser-ana");
  const password = "a long browser password";

  await page.goto(`/setup/${token}`);
  await expect(
    page.getByRole("heading", { name: "Configurar acesso" }),
  ).toBeVisible();
  await expect(page.getByRole("img", { name: /QR code/ })).toBeVisible();
  const secret =
    (await page.getByTestId("totp-secret").textContent())?.replace(/ /g, "") ??
    "";
  await page.getByLabel("Nova senha").fill(password);
  await page.getByLabel("Repita a senha").fill(password);
  await page.getByLabel("Código do aplicativo").fill(totp(secret));
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page).toHaveURL(/\/login\?configurado$/);
  await expect(page.getByRole("status")).toContainText(
    "Configuração concluída",
  );

  await page.getByLabel("Usuário").fill("browser-ana");
  await page.getByLabel("Senha").fill(password);
  await page.getByLabel("Código do aplicativo").fill("000000");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert")).toHaveText(GENERIC);

  await page.getByLabel("Senha").fill(password);
  await page.getByLabel("Código do aplicativo").fill(totp(secret, 1));
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("Conectado como")).toBeVisible();
  const cookies = await page.context().cookies();
  expect(
    cookies.find((c) => c.name === "__Host-webmail_session"),
  ).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });

  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

test("ban after 10 failures", async ({ page }) => {
  await page.goto("/login");
  for (let i = 0; i < 10; i++) {
    await page.getByLabel("Usuário").fill(`nobody${i}`);
    await page.getByLabel("Senha").fill("wrong password!");
    await page.getByLabel("Código do aplicativo").fill("000000");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("alert")).toHaveText(GENERIC);
  }
  await page.getByLabel("Senha").fill("wrong password!");
  await page.getByLabel("Código do aplicativo").fill("000000");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("alert")).toHaveText(BANNED);
});
