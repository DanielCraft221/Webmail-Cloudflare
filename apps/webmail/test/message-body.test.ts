import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/lib/server/db.ts";
import {
  FAILED_FOR,
  renderBody,
  withNotice,
} from "../src/lib/server/message-body.ts";
import { sanitizeEmailHtml } from "../src/lib/server/sanitize.ts";
import type {
  SanitizePool,
  SanitizeResult,
} from "../src/lib/server/sanitize-pool.ts";

const pool = (result: SanitizeResult): SanitizePool => ({
  run: async () => result,
});
const deps = (result: SanitizeResult) => ({
  sanitizer: pool(result),
  db: openDb(":memory:"),
});
const ID = "00000000-0000-4000-8000-000000000001";
const bodyOf = (html: string) => new JSDOM(html).window.document.body;

describe("withNotice", () => {
  it("goes right after the real <body>, even with '<body' and '>' in tricky places", () => {
    const { html } = sanitizeEmailHtml(
      `<html><head><style>a[title="<body>"]{color:red}</style></head><body title="a>b" style="color:#000"><p>oi</p></body></html>`,
    );
    const out = withNotice(
      `<!doctype html>${html}`,
      "Imagens remotas bloqueadas (1).",
    );
    const body = bodyOf(out);
    expect(body.getAttribute("title")).toBe("a>b");
    expect(body.firstElementChild?.textContent).toBe(
      "Imagens remotas bloqueadas (1).",
    );
    expect(body.lastElementChild?.textContent).toBe("oi");
  });

  it("escapes its own text", () => {
    const out = withNotice(
      "<html><head></head><body></body></html>",
      "<b>x</b>",
    );
    expect(bodyOf(out).querySelector("b")).toBeNull();
  });
});

describe("renderBody", () => {
  it("shows text-only mail as escaped text, line breaks kept", async () => {
    const r = await renderBody(
      ID,
      { text: "linha 1\n<b>linha 2</b>", html: null },
      deps({ ok: false, reason: "failed" }),
    );
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    const body = bodyOf(r.html);
    expect(body.querySelector("b")).toBeNull();
    expect(body.textContent).toBe("linha 1\n<b>linha 2</b>");
    expect(r.html).toContain("white-space:pre-wrap");
  });

  it("adds the blocked-images notice", async () => {
    const r = await renderBody(
      ID,
      { text: null, html: "x" },
      deps({
        ok: true,
        html: "<html><head></head><body><p>a</p></body></html>",
        blockedImages: 3,
      }),
    );
    expect(r.status === 200 && r.html).toContain(
      "Imagens remotas bloqueadas (3).",
    );
  });

  it.each([
    ["too_large", "grande demais"],
    ["failed", "Não foi possível exibir"],
    ["unavailable", "Não foi possível exibir"],
  ] as const)(
    "%s: shows the text version with a notice",
    async (reason, words) => {
      const r = await renderBody(
        ID,
        { text: "o texto", html: "<p>html</p>" },
        deps({ ok: false, reason }),
      );
      expect(r.status).toBe(200);
      if (r.status !== 200) return;
      expect(r.html).toContain(words);
      expect(r.html).toContain("o texto");
      expect(r.html).not.toContain("<p>html</p>");
    },
  );

  it("busy: 503", async () => {
    expect(
      await renderBody(
        ID,
        { text: null, html: "<p>x</p>" },
        deps({ ok: false, reason: "busy" }),
      ),
    ).toEqual({
      status: 503,
    });
  });

  it("no readable body: a notice pointing at the .eml", async () => {
    const r = await renderBody(ID, null, deps({ ok: false, reason: "failed" }));
    expect(r.status === 200 && r.html).toContain(".eml");
  });
});

describe("failed sanitizations are remembered for 6 hours", () => {
  const body = { text: "o texto", html: "<p>html</p>" };
  /** The first call gets `first`, every later one gets `rest` (or `first` again). */
  const counting = (first: SanitizeResult, rest = first) => {
    const calls: string[] = [];
    const sanitizer: SanitizePool = {
      run: async (html) => {
        calls.push(html);
        return calls.length === 1 ? first : rest;
      },
    };
    return { calls, deps: { sanitizer, db: openDb(":memory:") } };
  };
  const ok: SanitizeResult = {
    ok: true,
    html: "<html><head></head><body><p>limpo</p></body></html>",
    blockedImages: 0,
  };

  it("serves the text without a worker until the 6 hours are over", async () => {
    const { calls, deps } = counting({ ok: false, reason: "failed" }, ok);
    const t0 = 1_000_000;
    await renderBody(ID, body, deps, t0);
    const again = await renderBody(ID, body, deps, t0 + FAILED_FOR - 1);
    expect(calls).toHaveLength(1);
    expect(again.status === 200 && again.html).toContain("o texto");
    expect(again.status === 200 && again.html).toContain(
      "Não foi possível exibir",
    );
    // Other messages are not affected.
    await renderBody("00000000-0000-4000-8000-000000000002", body, deps, t0);
    expect(calls).toHaveLength(2);
    const later = await renderBody(ID, body, deps, t0 + FAILED_FOR);
    expect(calls).toHaveLength(3);
    expect(later.status === 200 && later.html).toContain("limpo");
  });

  it.each(["too_large", "busy", "unavailable"] as const)(
    "%s is not remembered",
    async (reason) => {
      const { calls, deps } = counting({ ok: false, reason }, ok);
      await renderBody(ID, body, deps, 0);
      await renderBody(ID, body, deps, 1);
      expect(calls).toHaveLength(2);
    },
  );

  it("drops expired entries when a new one is written", async () => {
    const { deps } = counting({ ok: false, reason: "failed" });
    await renderBody(ID, body, deps, 0);
    await renderBody(
      "00000000-0000-4000-8000-000000000002",
      body,
      deps,
      FAILED_FOR,
    );
    const rows = deps.db
      .prepare("SELECT message_id FROM sanitize_failed")
      .all() as { message_id: string }[];
    expect(rows.map((r) => r.message_id)).toEqual([
      "00000000-0000-4000-8000-000000000002",
    ]);
  });
});
