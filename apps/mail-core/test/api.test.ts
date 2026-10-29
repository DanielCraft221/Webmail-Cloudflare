import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contentDisposition, SEARCH_LIMIT } from "../src/api";
import worker from "../src/index";
import {
  addAttachment,
  addMessage,
  addTestUsers,
  apiEnv,
  call,
  OTHER,
} from "./api-helpers";
import htmlAttachment from "./fixtures/html-attachment.eml?raw";
import {
  attachments,
  deliverAndIngest,
  mailboxId,
  messages,
  reset,
} from "./helpers";

beforeEach(async () => {
  await reset();
  await addTestUsers();
});
afterEach(() => vi.restoreAllMocks());

type Json = Record<string, unknown>;

async function json(response: Response): Promise<Json> {
  return (await response.json()) as Json;
}

describe("GET /v1/mailboxes", () => {
  it("lists only readable mailboxes with unread counts per folder", async () => {
    await addMessage({ mailbox: "contato@survivus.com.br" });
    await addMessage({ mailbox: "contato@survivus.com.br", isRead: true });
    await addMessage({ mailbox: "contato@survivus.com.br", folder: "spam" });
    const body = await json(await call("/v1/mailboxes"));
    const list = body.mailboxes as Json[];
    expect(list.map((m) => m.address)).toEqual([
      "compras@survivus.com.br",
      "contato@survivus.com.br",
      "suporte@survivus.com.br",
    ]);
    expect(list[1]).toEqual({
      id: await mailboxId("contato@survivus.com.br"),
      address: "contato@survivus.com.br",
      displayName: "Contato",
      unread: { inbox: 1, archive: 0, spam: 1, trash: 0, sent: 0 },
    });

    const other = await json(await call("/v1/mailboxes", { user: OTHER }));
    expect((other.mailboxes as Json[]).map((m) => m.address)).toEqual([
      "suporte@survivus.com.br",
    ]);
  });
});

describe("permission: 404, the same as a missing resource", () => {
  it("hides mailboxes, messages, attachments and .eml of other mailboxes", async () => {
    const id = await addMessage({ mailbox: "contato@survivus.com.br" });
    const att = await addAttachment(id, {});
    const contato = await mailboxId("contato@survivus.com.br");
    const missing = await json(
      await call(`/v1/messages/${crypto.randomUUID()}`),
    );

    for (const path of [
      `/v1/mailboxes/${contato}/messages`,
      `/v1/messages/${id}`,
      `/v1/messages/${id}/attachments/${att}`,
      `/v1/messages/${id}/raw`,
    ]) {
      const response = await call(path, { user: OTHER });
      expect(response.status, path).toBe(404);
      expect(await json(response)).toEqual(missing);
    }
    const patch = await call(`/v1/messages/${id}`, {
      user: OTHER,
      method: "PATCH",
      body: { isRead: true },
    });
    expect(patch.status).toBe(404);
    expect((await messages())[0]?.is_read).toBe(0);
  });

  it("does not serve an attachment through another message's id", async () => {
    const hidden = await addMessage({ mailbox: "contato@survivus.com.br" });
    const hiddenAtt = await addAttachment(hidden, {});
    const allowed = await addMessage({ mailbox: "suporte@survivus.com.br" });
    const response = await call(
      `/v1/messages/${allowed}/attachments/${hiddenAtt}`,
      { user: OTHER },
    );
    expect(response.status).toBe(404);
  });

  it("answers 404 for a nonexistent mailbox and malformed ids", async () => {
    for (const path of [
      "/v1/mailboxes/999/messages",
      "/v1/mailboxes/abc/messages",
      "/v1/messages/not-a-uuid",
      `/v1/messages/${crypto.randomUUID()}/attachments/x`,
    ]) {
      expect((await call(path)).status, path).toBe(404);
    }
  });
});

describe("GET /v1/mailboxes/:id/messages", () => {
  it("pages by cursor without repeating or skipping, ties broken by id", async () => {
    const tie = "2026-10-05T12:00:00.000Z";
    const ids = [
      await addMessage({ receivedAt: "2026-10-01T00:00:00.000Z" }),
      await addMessage({ receivedAt: tie }),
      await addMessage({ receivedAt: tie }),
      await addMessage({ receivedAt: tie }),
      await addMessage({ receivedAt: "2026-10-06T00:00:00.000Z" }),
      await addMessage({ receivedAt: "2026-10-07T00:00:00.000Z" }),
      await addMessage({ receivedAt: "2026-10-08T00:00:00.000Z" }),
    ];
    await addMessage({ folder: "archive" });
    const expected = (await messages())
      .filter((m) => m.folder === "inbox")
      .sort((a, b) =>
        a.received_at === b.received_at
          ? String(b.id).localeCompare(String(a.id))
          : String(b.received_at).localeCompare(String(a.received_at)),
      )
      .map((m) => m.id);
    expect(expected).toHaveLength(ids.length);

    const contato = await mailboxId("contato@survivus.com.br");
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : "";
      const page = await json(
        await call(`/v1/mailboxes/${contato}/messages?limit=3${query}`),
      );
      seen.push(...(page.messages as Json[]).map((m) => m.id));
      cursor = page.nextCursor as string | null;
    } while (cursor);
    expect(seen).toEqual(expected);
  });

  it("filters by folder and returns the summary shape", async () => {
    const id = await addMessage({ folder: "archive", subject: "Arquivada" });
    const contato = await mailboxId("contato@survivus.com.br");
    const page = await json(
      await call(`/v1/mailboxes/${contato}/messages?folder=archive`),
    );
    expect(page).toEqual({
      messages: [
        {
          id,
          mailboxId: contato,
          folder: "archive",
          from: { address: "ana.teste@example.net", name: "Ana Teste" },
          subject: "Arquivada",
          snippet: "snippet",
          date: null,
          receivedAt: expect.any(String),
          size: expect.any(Number),
          hasAttachments: false,
          isRead: false,
          auth: { spf: "unknown", dkim: "unknown", dmarc: "unknown" },
          parseStatus: "ok",
        },
      ],
      nextCursor: null,
    });
  });

  it.each([
    "limit=101",
    "limit=0",
    "limit=abc",
    "folder=drafts",
    "cursor=bad",
    `cursor=${btoa("2026-10-01|x")}`,
  ])("rejects %s with 400", async (query) => {
    const contato = await mailboxId("contato@survivus.com.br");
    const response = await call(`/v1/mailboxes/${contato}/messages?${query}`);
    expect(response.status).toBe(400);
  });
});

describe("GET /v1/messages/:id and downloads", () => {
  it("returns metadata, body as JSON data and attachments of a real message", async () => {
    await deliverAndIngest(htmlAttachment, { to: "suporte@survivus.com.br" });
    const [row] = await messages();
    const [att] = await attachments();
    const response = await call(`/v1/messages/${row?.id}`);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    const body = await json(response);
    expect(body).toMatchObject({
      id: row?.id,
      subject: row?.subject,
      cc: [{ address: "carla@example.org", name: "Carla" }],
      hasAttachments: true,
      attachments: [
        {
          id: att?.id,
          filename: "relatorio-interno-9931.pdf",
          contentType: "application/pdf",
          size: att?.size,
          isInline: false,
        },
      ],
    });
    expect((body.body as Json).html).toEqual(expect.stringContaining("<"));

    const download = await call(
      `/v1/messages/${row?.id}/attachments/${att?.id}`,
    );
    expect(download.status).toBe(200);
    expect((await download.arrayBuffer()).byteLength).toBe(att?.size);
  });

  it("serves a text/html attachment as an octet-stream download", async () => {
    const id = await addMessage();
    const att = await addAttachment(id, {
      filename: "pagina.html",
      contentType: "text/html",
      content: "<script>alert(1)</script>",
    });
    const response = await call(`/v1/messages/${id}/attachments/${att}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="pagina.html"; filename*=UTF-8''pagina.html`,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe("<script>alert(1)</script>");
  });

  it("serves the .eml with the same download headers", async () => {
    const id = await addMessage();
    const response = await call(`/v1/messages/${id}/raw`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${id}.eml"; filename*=UTF-8''${id}.eml`,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toContain(`Corpo ${id}`);
  });

  it("makes a hostile attachment name safe in Content-Disposition", async () => {
    const id = await addMessage();
    const att = await addAttachment(id, {
      filename: '../"Relatório"\r\nfinal.html',
    });
    const response = await call(`/v1/messages/${id}/attachments/${att}`);
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="__Relat_rio_final.html"; filename*=UTF-8''_%22Relat%C3%B3rio%22final.html`,
    );
  });
});

describe("contentDisposition", () => {
  it.each([
    [null, `attachment; filename="anexo"; filename*=UTF-8''anexo`],
    ["...", `attachment; filename="anexo"; filename*=UTF-8''anexo`],
    [
      "a\\b/c.txt",
      `attachment; filename="a_b_c.txt"; filename*=UTF-8''a_b_c.txt`,
    ],
    [
      "fatura\u202Efdp.exe",
      `attachment; filename="faturafdp.exe"; filename*=UTF-8''faturafdp.exe`,
    ],
    [
      "it's (1)*.txt",
      `attachment; filename="it's (1)*.txt"; filename*=UTF-8''it%27s%20%281%29%2A.txt`,
    ],
    ["\ud800x.txt", `attachment; filename="x.txt"; filename*=UTF-8''x.txt`],
  ])("%j", (name, expected) => {
    expect(contentDisposition(name, "anexo")).toBe(expected);
  });

  // Trojan Source controls, built from code points so this file stays free of literal bidi characters.
  it.each([
    "202A",
    "202B",
    "202C",
    "202D",
    "202E",
    "2066",
    "2067",
    "2068",
    "2069",
  ])("removes bidi control U+%s", (hex) => {
    const name = `fatura${String.fromCodePoint(Number.parseInt(hex, 16))}fdp.exe`;
    expect(contentDisposition(name, "anexo")).toBe(
      `attachment; filename="faturafdp.exe"; filename*=UTF-8''faturafdp.exe`,
    );
  });

  it("caps the name at 200 characters without splitting one", () => {
    const header = contentDisposition("😀".repeat(300), "anexo");
    const encoded = header.split("UTF-8''")[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe("😀".repeat(200));
  });
});

describe("PATCH /v1/messages/:id", () => {
  it("marks as read, changing the unread count", async () => {
    const id = await addMessage();
    const unread = async () => {
      const list = (await json(await call("/v1/mailboxes")))
        .mailboxes as Json[];
      const contato = list.find((m) => m.address === "contato@survivus.com.br");
      return (contato?.unread as Json | undefined)?.inbox;
    };
    expect(await unread()).toBe(1);
    const response = await call(`/v1/messages/${id}`, {
      method: "PATCH",
      body: { isRead: true },
    });
    expect(await json(response)).toEqual({ id, isRead: true, folder: "inbox" });
    expect(await unread()).toBe(0);
  });

  it("moves to an allowed folder", async () => {
    const id = await addMessage();
    const response = await call(`/v1/messages/${id}`, {
      method: "PATCH",
      body: { folder: "archive", isRead: false },
    });
    expect(await json(response)).toEqual({
      id,
      isRead: false,
      folder: "archive",
    });
  });

  it.each([
    ["folder sent", { folder: "sent" }],
    ["an unknown folder", { folder: "drafts" }],
    ["an empty body", {}],
    ["an unknown field", { isRead: true, mailboxId: 1 }],
    ["a non-boolean isRead", { isRead: "yes" }],
    ["invalid JSON", "{"],
  ])("rejects %s with 400", async (_, body) => {
    const id = await addMessage();
    const response = await call(`/v1/messages/${id}`, {
      method: "PATCH",
      body,
    });
    expect(response.status).toBe(400);
    expect((await messages())[0]).toMatchObject({
      folder: "inbox",
      is_read: 0,
    });
  });
});

describe("GET /v1/search", () => {
  it("treats % and _ as text, not wildcards", async () => {
    const percent = await addMessage({ subject: "Desconto de 100% hoje" });
    await addMessage({ subject: "Desconto de 100 reais" });
    const underscore = await addMessage({ subject: "arquivo_final" });
    await addMessage({ subject: "arquivoXfinal" });
    const ids = async (q: string) =>
      (
        (await json(await call(`/v1/search?q=${encodeURIComponent(q)}`)))
          .messages as Json[]
      ).map((m) => m.id);
    expect(await ids("100%")).toEqual([percent]);
    expect(await ids("o_f")).toEqual([underscore]);
    expect(await ids("%")).toEqual([percent]);
  });

  it("searches subject, sender address and sender name", async () => {
    const bySubject = await addMessage({ subject: "Pedido 77" });
    const byAddress = await addMessage({ from: "pedido@loja.example" });
    const byName = await addMessage({ fromName: "Setor de Pedidos" });
    await addMessage({ subject: "Outro" });
    const found = (await json(await call("/v1/search?q=pedido")))
      .messages as Json[];
    expect(found.map((m) => m.id).sort()).toEqual(
      [bySubject, byAddress, byName].sort(),
    );
  });

  it("returns only messages from mailboxes the user may read", async () => {
    await addMessage({
      mailbox: "contato@survivus.com.br",
      subject: "Segredo A",
    });
    const allowed = await addMessage({
      mailbox: "suporte@survivus.com.br",
      subject: "Segredo B",
    });
    const found = (
      await json(await call("/v1/search?q=Segredo", { user: OTHER }))
    ).messages as Json[];
    expect(found.map((m) => m.id)).toEqual([allowed]);

    const contato = await mailboxId("contato@survivus.com.br");
    const filtered = await json(
      await call(`/v1/search?q=Segredo&mailbox=${contato}`, { user: OTHER }),
    );
    expect(filtered.messages).toEqual([]);
  });

  it(`caps results at ${SEARCH_LIMIT}`, async () => {
    for (let i = 0; i < SEARCH_LIMIT + 2; i++)
      await addMessage({ subject: "Lote" });
    const found = (await json(await call("/v1/search?q=Lote")))
      .messages as Json[];
    expect(found).toHaveLength(SEARCH_LIMIT);
  });

  it.each(["", "q=", `q=${"a".repeat(101)}`, "q=a&mailbox=x"])(
    "rejects %j with 400",
    async (query) => {
      expect((await call(`/v1/search?${query}`)).status).toBe(400);
    },
  );
});

describe("responses", () => {
  it("answers an internal error with generic JSON, no stack trace", async () => {
    const failing = {
      ...apiEnv,
      DB: {
        prepare: () => {
          throw new Error("D1 unavailable at line 42");
        },
      } as unknown as D1Database,
    };
    const response = await call("/v1/mailboxes", { env: failing });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal_error"}');
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("errors carry nosniff and no-store", async () => {
    const id = await addMessage();
    for (const response of [
      await call("/v1/mailboxes", { headers: { Authorization: null } }),
      await call(`/v1/messages/${crypto.randomUUID()}`),
      await call(`/v1/messages/${id}`, { method: "PATCH", body: {} }),
    ]) {
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  it("keeps everything outside /v1 at 404", async () => {
    for (const path of ["/", "/admin", "/v2/mailboxes", "/v1x"]) {
      const response = await worker.fetch(
        new Request(`https://mail-api.test${path}`),
        env,
        createExecutionContext(),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it("never sends Access-Control-* headers, even to a preflight", async () => {
    const id = await addMessage();
    const att = await addAttachment(id, {});
    const origin = { Origin: "https://evil.example" };
    const responses = [
      await call("/v1/mailboxes", { headers: origin }),
      await call(`/v1/messages/${id}`, { headers: origin }),
      await call(`/v1/messages/${id}/attachments/${att}`, { headers: origin }),
      await call(`/v1/messages/${id}`, {
        method: "OPTIONS",
        headers: { ...origin, "Access-Control-Request-Method": "PATCH" },
      }),
      await call("/v1/mailboxes", {
        headers: { ...origin, Authorization: null },
      }),
    ];
    for (const response of responses) {
      const names = [...response.headers.keys()];
      expect(names.filter((n) => n.startsWith("access-control-"))).toEqual([]);
    }
  });
});

describe("API logs", () => {
  it("hold user, route pattern, status and time, never content or the search term", async () => {
    const lines: string[] = [];
    await deliverAndIngest(htmlAttachment, { to: "suporte@survivus.com.br" });
    const [row] = await messages();
    const [att] = await attachments();
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    await call(`/v1/messages/${row?.id}`);
    await call(`/v1/messages/${row?.id}/attachments/${att?.id}`);
    await call(`/v1/messages/${row?.id}/raw`);
    await call("/v1/search?q=termo-secreto-5521");
    await call("/v1/search?q=Relatorio");
    await call(`/v1/mailboxes/${row?.mailbox_id}/messages?folder=inbox`);

    const logged = lines.join("\n");
    const entries = lines.map((l) => JSON.parse(l) as Json);
    expect(entries[0]).toEqual({
      event: "api_request",
      route: "GET /v1/messages/:id",
      user: "b2a98933-aa45-4af9-b0f3-dd58c4283e7b",
      httpStatus: 200,
      ms: expect.any(Number),
    });
    expect(entries.map((e) => e.route)).toContain("GET /v1/search");
    for (const secret of [
      "Relatorio",
      "relatorio-interno-9931",
      "termo-secreto-5521",
      "carla@example.org",
      "bruno",
      "@example",
      String(row?.id),
      "?",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
