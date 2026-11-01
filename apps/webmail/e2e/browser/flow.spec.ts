import { expect, test } from "@playwright/test";
import { BANNED, createUser, freshIp, GENERIC, totp } from "../helpers.ts";

// Firefox only: it accepts __Host- cookies on http://localhost (docs/webmail-auth.md).
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
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
