import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { renderBody, withNotice } from "../src/lib/server/message-body.ts";
import { sanitizeEmailHtml } from "../src/lib/server/sanitize.ts";
import type {
  SanitizePool,
  SanitizeResult,
} from "../src/lib/server/sanitize-pool.ts";

const pool = (result: SanitizeResult): SanitizePool => ({
  run: async () => result,
});
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
      { text: "linha 1\n<b>linha 2</b>", html: null },
      pool({ ok: false, reason: "failed" }),
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
      { text: null, html: "x" },
      pool({
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
  ] as const)(
    "%s: shows the text version with a notice",
    async (reason, words) => {
      const r = await renderBody(
        { text: "o texto", html: "<p>html</p>" },
        pool({ ok: false, reason }),
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
        { text: null, html: "<p>x</p>" },
        pool({ ok: false, reason: "busy" }),
      ),
    ).toEqual({
      status: 503,
    });
  });

  it("no readable body: a notice pointing at the .eml", async () => {
    const r = await renderBody(null, pool({ ok: false, reason: "failed" }));
    expect(r.status === 200 && r.html).toContain(".eml");
  });
});
