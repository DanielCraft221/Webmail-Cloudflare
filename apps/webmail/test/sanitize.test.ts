import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { cleanCss, sanitizeEmailHtml } from "../src/lib/server/sanitize.ts";
import { MALICIOUS_HTML, MXSS_VECTORS } from "./fixtures/emails.ts";

const FORBIDDEN = new Set([
  ...[
    "script",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "button",
    "select",
    "textarea",
  ],
  ...[
    "base",
    "meta",
    "link",
    "svg",
    "math",
    "frame",
    "frameset",
    "noscript",
    "template",
  ],
]);

/**
 * Parses the output again, as the browser will, and lists anything that could run, load or
 * submit. Empty means inert.
 */
function dangers(html: string): string[] {
  const doc = new JSDOM(html).window.document;
  const found: string[] = [];
  for (const el of doc.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (FORBIDDEN.has(tag)) found.push(`<${tag}>`);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) found.push(`${tag}[${name}]`);
      if (
        ["background", "srcset", "formaction", "action", "id", "name"].includes(
          name,
        )
      )
        found.push(`${tag}[${name}]`);
      if (name === "href" && !/^(https?:|mailto:)/i.test(attr.value))
        found.push(`href=${attr.value}`);
      if (
        name === "src" &&
        !/^data:image\/(?:png|jpeg|gif|webp)[;,]/i.test(attr.value)
      )
        found.push(`src=${attr.value}`);
      if (name === "style" && /url\s*\(|\\/i.test(attr.value))
        found.push(`style=${attr.value}`);
    }
  }
  for (const style of doc.querySelectorAll("style"))
    if (/@import|url\s*\(|\\|image-set/i.test(style.textContent ?? ""))
      found.push(`style text: ${style.textContent}`);
  return found;
}

describe("sanitizeEmailHtml: attack corpus", () => {
  it.each([
    ["<script>", "<p>a</p><script>alert(1)</script>"],
    ["<img onerror>", `<img src="x" onerror="alert(1)">`],
    ["<body onload>", `<html><body onload="alert(1)"><p>a</p></body></html>`],
    ["SVG with script", `<svg><script>alert(1)</script></svg>`],
    ["MathML", `<math><mi>x</mi></math>`],
    [
      "<form>, <input>, <button formaction>",
      `<form action="https://e.example"><input name=a><button formaction="https://e.example">b</button></form>`,
    ],
    ["<base href>", `<base href="https://e.example/">`],
    [
      "<meta refresh>",
      `<meta http-equiv="refresh" content="0;url=https://e.example">`,
    ],
    ["<link>", `<link rel="stylesheet" href="https://e.example/a.css">`],
    [
      "<iframe>, <object>, <embed>",
      `<iframe src="https://e.example"></iframe><object data="x"></object><embed src="x">`,
    ],
    [
      "background and srcset",
      `<table background="https://e.example/a.png"><tr><td><img srcset="https://e.example/b.png 2x"></td></tr></table>`,
    ],
    ["id and name (DOM clobbering)", `<p id="cookie" name="x">a</p>`],
    ["the whole malicious email", MALICIOUS_HTML],
  ])("%s: removed", (_name, html) => {
    expect(dangers(sanitizeEmailHtml(html).html)).toEqual([]);
  });

  it.each(MXSS_VECTORS)("mXSS stays inert: %s", (html) => {
    const once = sanitizeEmailHtml(html).html;
    expect(dangers(once)).toEqual([]);
    // Parsing the output again changes nothing that matters (no mutation into something live).
    expect(dangers(sanitizeEmailHtml(once).html)).toEqual([]);
  });

  it.each([
    ["javascript:", `<a href="javascript:alert(1)">texto</a>`],
    [
      "data:text/html",
      `<a href="data:text/html,<script>alert(1)</script>">texto</a>`,
    ],
    ["vbscript:", `<a href="vbscript:msgbox(1)">texto</a>`],
    ["relative (would point at the webmail)", `<a href="/logout">texto</a>`],
    ["protocol-relative", `<a href="//evil.example/x">texto</a>`],
    ["anchor", `<a href="#x">texto</a>`],
    ["cid: (later)", `<a href="cid:abc">texto</a>`],
  ])("a %s link becomes text", (_name, html) => {
    const doc = new JSDOM(sanitizeEmailHtml(html).html).window.document;
    const link = doc.querySelector("a");
    expect(link?.hasAttribute("href") ?? false).toBe(false);
    expect(doc.body.textContent).toContain("texto");
  });

  it("keeps a normal https link, opening in a new tab without referrer or opener", () => {
    const doc = new JSDOM(
      sanitizeEmailHtml(
        `<a href="https://ok.example/p?a=1" target="_top" rel="opener">ok</a>`,
      ).html,
    ).window.document;
    const link = doc.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://ok.example/p?a=1");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps mailto: links", () => {
    const html = sanitizeEmailHtml(
      `<a href="mailto:ana@example.com">Ana</a>`,
    ).html;
    expect(html).toContain(`href="mailto:ana@example.com"`);
  });

  it("removes remote images and counts them; keeps data: images", () => {
    const out = sanitizeEmailHtml(
      `<img src="https://tracker.example/a.gif"><img src="http://t.example/b.png"><img src="data:image/png;base64,iVBORw0KGgo=">`,
    );
    expect(out.blockedImages).toBe(2);
    const imgs = new JSDOM(out.html).window.document.querySelectorAll("img");
    expect(imgs[0]?.hasAttribute("src")).toBe(false);
    expect(imgs[0]?.getAttribute("alt")).toBe("Imagem remota bloqueada");
    expect(imgs[2]?.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("keeps only png, jpeg, gif and webp as data: images", () => {
    const kept = ["png", "jpeg", "gif", "webp"].map(
      (t) => `data:image/${t};base64,AAAA`,
    );
    const dropped = [
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "data:image/bmp;base64,AAAA",
      "data:image/pngx;base64,AAAA",
      "data:image/x-icon;base64,AAAA",
    ];
    const out = sanitizeEmailHtml(
      [...kept, ...dropped].map((s) => `<img src="${s}">`).join(""),
    );
    const imgs = Array.from(
      new JSDOM(out.html).window.document.querySelectorAll("img"),
    );
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual([
      ...kept,
      ...dropped.map(() => null),
    ]);
    expect(imgs[4]?.getAttribute("alt")).toBe("Imagem bloqueada");
    // Not remote, so not in the "remote images blocked" count.
    expect(out.blockedImages).toBe(0);
  });

  it("counts from zero on every call", () => {
    sanitizeEmailHtml(`<img src="https://t.example/a.gif">`);
    expect(sanitizeEmailHtml("<p>a</p>").blockedImages).toBe(0);
  });

  it("keeps the <style> of <head> and the layout an email needs", () => {
    const html = sanitizeEmailHtml(
      `<html><head><style>.x{color:red}</style></head><body><table width="600" align="center"><tr><td class="x" style="padding:4px;color:#333">oi</td></tr></table></body></html>`,
    ).html;
    expect(html).toContain("<style>.x{color:red}</style>");
    expect(html).toContain(`style="padding:4px;color:#333"`);
    expect(html).toContain(`width="600"`);
  });
});

describe("cleanCss (extra layer; the body route's CSP is the one that blocks)", () => {
  it.each([
    "@import url(https://e.example/a.css);",
    `@import "https://e.example/a.css";`,
    "a{background:url(https://e.example/a.png)}",
    "a{background:ur/**/l(https://e.example/a.png)}",
    "a{background:\\75 rl(https://e.example/a.png)}",
    `a{background:url( "https://e.example/a b.png" )}`,
    `a{background-image:image-set("https://e.example/a.png" 1x)}`,
    "@font-face{font-family:x;src:url(https://e.example/f.woff)}",
    "a{width:expression(alert(1))}",
  ])("%s: nothing left that loads", (css) => {
    expect(cleanCss(css)).not.toMatch(
      /url|@import|image-set|expression|\\|e\.example/i,
    );
  });

  it("stays linear on a long stylesheet (1 MB without separators)", () => {
    const started = performance.now();
    cleanCss(`a{color:${"r".repeat(1024 * 1024)}`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps ordinary declarations", () => {
    expect(cleanCss("a{color:red;padding:4px}")).toBe(
      "a{color:red;padding:4px}",
    );
  });

  it("drops every '<', so no tag can hide in a stylesheet", () => {
    expect(cleanCss(`a[title="<body>"]{color:red}`)).not.toContain("<");
  });
});
