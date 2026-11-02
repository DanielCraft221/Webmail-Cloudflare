import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import { APP_PORT } from "../../playwright.config.ts";
import {
  HTML_ATTACHMENT,
  MSG,
  TRICKY_NAME,
} from "../../test/fixtures/emails.ts";
import { get, isRead, loggedIn, remember } from "../helpers.ts";

// Ids and names must never reach the log (e2e/logs.spec.ts reads what is remembered here).
remember(...Object.values(MSG), TRICKY_NAME);

const NOT_FOUND = "Mensagem não encontrada";
/** Written out here on purpose: a change to the body route's CSP has to change this test too. */
const BODY_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";
const body = (id: string) => `/mensagens/${id}/corpo`;

/** OS threads of the app built and started by Playwright (Linux): one per live worker, and more. */
function appThreads(): number {
  const out = execFileSync("ss", ["-Hltnp", `sport = :${APP_PORT}`], {
    encoding: "utf8",
  });
  const pid = /pid=(\d+)/.exec(out)?.[1];
  if (!pid) throw new Error(`no process listening on ${APP_PORT}: ${out}`);
  return readdirSync(`/proc/${pid}/task`).length;
}

test.describe("reading", () => {
  let session: Awaited<ReturnType<typeof loggedIn>>;
  test.beforeAll(async ({ request }) => {
    // A new name each time: Playwright runs beforeAll again after a failure.
    session = await loggedIn(request, `e2e-reader-${Date.now()}`);
  });
  const open = (path: string) =>
    get(null as never, path, session.ip, session.cookie);

  test("the body route: its exact CSP, frameable only by us, no-store, sanitized", async () => {
    const res = await open(body(MSG.malicious));
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-security-policy"]).toBe(BODY_CSP);
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-dns-prefetch-control"]).toBe("off");
    expect(h["cache-control"]).toBe("no-store");
    expect(h["content-type"]).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain("Olá, esta é uma mensagem de teste.");
    expect(html).toContain("Imagens remotas bloqueadas (2).");
    // Layer 1 in the build: nothing that runs, loads or submits.
    expect(html).not.toMatch(
      /<script|onerror|onload|<iframe|<form|<base|<meta|<link|javascript:/i,
    );
  });

  test("every other page keeps frame-ancestors 'none', DENY and no unsafe-inline", async () => {
    for (const path of ["/", "/login", `/mensagens/${MSG.malicious}`]) {
      const h = (await open(path)).headers();
      expect(h["content-security-policy"], path).toContain(
        "frame-ancestors 'none'",
      );
      expect(h["content-security-policy"], path).not.toContain("unsafe-inline");
      expect(h["x-frame-options"], path).toBe("DENY");
    }
  });

  test("the body route without a session redirects to the login, with no content", async ({
    request,
  }) => {
    const res = await get(request, body(MSG.malicious), session.ip);
    expect(res.status()).toBe(303);
    expect(res.headers().location).toBe("/login");
    expect(await res.text()).not.toContain("Olá");
  });

  test("the message page: sandboxed iframe, and the body never in the page itself", async () => {
    const res = await open(`/mensagens/${MSG.malicious}`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    const iframe = /<iframe[^>]*>/.exec(html)?.[0] ?? "";
    expect(iframe).toContain(`src="${body(MSG.malicious)}"`);
    expect(iframe).toContain(
      `sandbox="allow-popups allow-popups-to-escape-sandbox"`,
    );
    expect(iframe).toContain(`referrerpolicy="no-referrer"`);
    expect(html).not.toContain("evil.example");
    // Name and real address side by side (Svelte escapes the "<").
    expect(html).toMatch(/Remetente &lt;remetente@example\.com(&gt;|>)/);
  });

  test("opening a message (page and body) does not mark it as read", async ({
    request,
  }) => {
    await open(`/mensagens/${MSG.textOnly}`);
    await open(body(MSG.textOnly));
    expect(await isRead(request, MSG.textOnly)).toBe(false);
  });

  test("text-only mail is escaped text", async () => {
    const html = await (await open(body(MSG.textOnly))).text();
    expect(html).toContain("linha 1\n&#60;b&#62;linha 2&#60;/b&#62;");
  });

  test("HTML above the limit shows the text, and the page offers the .eml", async () => {
    const html = await (await open(body(MSG.large))).text();
    expect(html).toContain("grande demais");
    expect(html).toContain("Texto da mensagem grande.");
    expect(html).not.toContain("linha de newsletter grande");
    expect(await (await open(`/mensagens/${MSG.large}`)).text()).toContain(
      `/mensagens/${MSG.large}/eml`,
    );
  });

  test("a message the parser could not read points at the .eml", async () => {
    expect(await (await open(body(MSG.unparsed))).text()).toContain(".eml");
  });

  test("an attachment declared text/html downloads as octet-stream, never rendered", async () => {
    const res = await open(
      `/mensagens/${MSG.malicious}/anexos/${MSG.htmlAttachment}`,
    );
    expect(res.status()).toBe(200);
    const h = res.headers();
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h["content-disposition"]).toBe(
      `attachment; filename="pagina.html"; filename*=UTF-8''pagina.html`,
    );
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-dns-prefetch-control"]).toBe("off");
    expect(h["cache-control"]).toBe("private, no-store");
    expect(h["x-fake-worker-header"]).toBeUndefined();
    expect(await res.text()).toBe(HTML_ATTACHMENT);
  });

  test("an attachment name with quotes, a line break, ../ and accents gives one safe header", async () => {
    const h = (
      await open(`/mensagens/${MSG.malicious}/anexos/${MSG.trickyName}`)
    ).headers();
    expect(h["content-disposition"]).toBe(
      `attachment; filename="fatura _final_.._.._relat_rio a__o.html"; filename*=UTF-8''fatura%20%22final%22.._.._relat%C3%B3rio%20a%C3%A7%C3%A3o.html`,
    );
  });

  test("the .eml downloads with the webmail's headers", async () => {
    const res = await open(`/mensagens/${MSG.malicious}/eml`);
    const h = res.headers();
    expect(h["content-type"]).toBe("application/octet-stream");
    expect(h["content-disposition"]).toBe(
      `attachment; filename="${MSG.malicious}.eml"; filename*=UTF-8''${MSG.malicious}.eml`,
    );
    expect(h["cache-control"]).toBe("private, no-store");
  });

  test("another mailbox's message looks exactly like one that does not exist", async () => {
    const answers = [];
    for (const id of [MSG.otherMailbox, MSG.missing, "not-a-uuid"])
      for (const path of [
        `/mensagens/${id}`,
        body(id),
        `/mensagens/${id}/eml`,
        `/mensagens/${id}/anexos/${MSG.htmlAttachment}`,
      ]) {
        const res = await open(path);
        const text = (await res.text()).replace(
          /nonce-[^']+|nonce="[^"]+"/g,
          "",
        );
        expect(res.status(), path).toBe(404);
        expect(text, path).toContain(NOT_FOUND);
        answers.push(`${path.replace(id, "ID")} ${text}`);
      }
    // Same answers for the three ids, path by path.
    expect(new Set(answers).size).toBe(4);
  });

  // Against the build: if the sanitizer ever ran on the main thread (a broken dynamic import,
  // a synchronous fallback), the three requests would be served one after the other: no 503.
  test("a third sanitization at the same time gets 503", async () => {
    const statuses = await Promise.all(
      [1, 2, 3].map(() => open(body(MSG.slow)).then((r) => r.status())),
    );
    expect(statuses.sort()).toEqual([200, 200, 503]);
  });

  test("a hung worker is terminated at the 10 s timeout, never reused, and never blocks the server", async ({
    request,
  }) => {
    test.setTimeout(60_000);
    // A worker already running in the first slot, the one the next request takes.
    expect((await open(body(MSG.textOnly))).status()).toBe(200);
    await open(body(MSG.malicious));
    const started = Date.now();
    const hung = open(body(MSG.hang)).then(async (r) => ({
      status: r.status(),
      html: await r.text(),
      at: Date.now(),
    }));
    await sleep(1_000);
    const during = appThreads();
    // The main thread still answers while the worker is stuck (off-main-thread proof).
    const login = await get(request, "/login", session.ip);
    const loginAt = Date.now();
    expect(login.status()).toBe(200);
    const result = await hung;
    expect(loginAt).toBeLessThan(result.at);
    expect(result.at - started).toBeGreaterThanOrEqual(9_000);
    expect(result.status).toBe(200);
    expect(result.html).toContain("Não foi possível exibir");
    // terminate(), not just forgotten: the stuck thread is gone.
    await sleep(500);
    expect(appThreads()).toBeLessThan(during);
    // The next message gets a fresh worker and is sanitized normally.
    const next = await (await open(body(MSG.malicious))).text();
    expect(next).toContain("Olá, esta é uma mensagem de teste.");
    expect(next).not.toMatch(/<script|onerror/i);
    // Remembered for 6 hours: reopening it answers at once with the text, without a worker.
    const reopenedAt = Date.now();
    const reopened = await open(body(MSG.hang));
    expect(Date.now() - reopenedAt).toBeLessThan(2_000);
    expect(await reopened.text()).toContain("Não foi possível exibir");
  });
});
