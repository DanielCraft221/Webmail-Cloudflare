/**
 * Email HTML sanitizer (docs/webmail-leitura.md). Layer 1 of 3: the body route's own CSP and the
 * iframe sandbox must block an attack even when this layer lets something through.
 *
 * Runs inside a worker thread (sanitize-pool.ts). The pool imports this module dynamically, so
 * the build gives it its own chunk, and starts the worker from that same file (WORKER_URL).
 */

import { isMainThread, parentPort } from "node:worker_threads";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

export interface Sanitized {
  html: string;
  blockedImages: number;
}

// Allow-list, never a block-list. No form, input, button, base, meta, link, iframe, object,
// embed, svg, math, video, audio, source or picture: they submit, navigate or load.
const ALLOWED_TAGS = [
  ...["html", "head", "body", "style"],
  ...["div", "span", "p", "br", "hr", "a", "img", "center", "font"],
  ...[
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "caption",
    "colgroup",
    "col",
  ],
  ...["h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd"],
  ...[
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "strike",
    "del",
    "ins",
    "mark",
    "small",
    "big",
  ],
  ...[
    "sub",
    "sup",
    "blockquote",
    "pre",
    "code",
    "tt",
    "kbd",
    "samp",
    "abbr",
    "cite",
    "q",
  ],
  ...[
    "address",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "nav",
    "aside",
  ],
  ...[
    "figure",
    "figcaption",
    "time",
    "wbr",
    "bdi",
    "bdo",
    "details",
    "summary",
  ],
];
// No `background` or `srcset` (they load), no `id`/`name` (DOM clobbering), no `target`/`rel`
// (set by the link hook below), no data-* attributes.
const ALLOWED_ATTR = [
  ...["href", "src", "alt", "title", "width", "height", "style", "class"],
  ...[
    "align",
    "valign",
    "bgcolor",
    "color",
    "border",
    "cellpadding",
    "cellspacing",
  ],
  ...[
    "colspan",
    "rowspan",
    "dir",
    "lang",
    "face",
    "size",
    "start",
    "type",
    "role",
    "datetime",
  ],
];

/**
 * One frozen object for every call, never a global config. The options behind most DOMPurify
 * advisories are banned by forbidden-patterns.test.ts (docs/webmail-leitura.md).
 */
const CONFIG = Object.freeze({
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  // DOMPurify's default minus every scheme but http, https and mailto. It is also tested on
  // non-URL attributes (width="600"), hence the scheme-less branch; the link hook below then
  // removes relative and scheme-less hrefs, which would point at the webmail itself.
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  // Keeps the <style> of <head>, which newsletters depend on.
  WHOLE_DOCUMENT: true,
});

// Anything that can load a resource or hide one behind an escape.
const LOADS =
  /\\|url\s*\(|image-set\s*\(|image\s*\(|element\s*\(|expression\s*\(|@import|@font-face/i;

/**
 * Extra layer only: the body route's CSP (img-src data:, no font-src) is what blocks remote CSS
 * loads. Drops comments, then every rule or declaration that could load something or hide it
 * behind an escape (`\75 rl(` is `url(`).
 */
export function cleanCss(css: string): string {
  return (
    css
      // No "<" either: CSS never needs it, and then no "<body" can appear before the real one.
      .replace(/</g, "")
      .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "")
      // Linear on purpose: split at ; { } and drop each piece that loads. A single regex with
      // [^;{}]* before the alternatives was quadratic (40 KB took 2 s).
      .split(/([;{}])/)
      .filter((piece) => !LOADS.test(piece))
      .join("")
  );
}

let purifier: ReturnType<typeof createPurifier> | undefined;

function createPurifier() {
  const purify = createDOMPurify(new JSDOM("").window);
  let blocked = 0;
  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style")
      node.textContent = cleanCss(node.textContent ?? "");
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    // These hooks only remove things or write fixed values: their output is not checked again.
    const element = node as Element;
    if (typeof element.getAttribute !== "function") return;
    const style = element.getAttribute("style");
    if (style !== null) {
      const cleaned = cleanCss(style).trim();
      if (cleaned) element.setAttribute("style", cleaned);
      else element.removeAttribute("style");
    }
    const href = element.getAttribute("href");
    if (href !== null && !/^(?:https?:|mailto:)/i.test(href.trim()))
      element.removeAttribute("href");
    if (element.nodeName === "A" && element.hasAttribute("href")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer");
    }
    if (element.nodeName === "IMG") {
      const src = element.getAttribute("src");
      // Only raster images inline: no data:image/svg+xml, which is a document of its own.
      if (
        src !== null &&
        !/^data:image\/(?:png|jpeg|gif|webp)[;,]/i.test(src)
      ) {
        element.removeAttribute("src");
        // Only remote images count for the "remote images blocked" notice.
        const remote = !/^\s*data:/i.test(src);
        element.setAttribute(
          "alt",
          remote ? "Imagem remota bloqueada" : "Imagem bloqueada",
        );
        if (remote) blocked++;
      }
    }
  });
  return {
    run(html: string): Sanitized {
      blocked = 0;
      const out = purify.sanitize(html, CONFIG);
      return { html: out, blockedImages: blocked };
    },
  };
}

/** This module's own file: the source in dev and tests, its chunk in the build. */
export const WORKER_URL = import.meta.url;

export function sanitizeEmailHtml(html: string): Sanitized {
  purifier ??= createPurifier();
  return purifier.run(html);
}

// Worker side: one HTML string in, one Sanitized out.
if (!isMainThread && parentPort) {
  const port = parentPort;
  port.on("message", (html: string) =>
    port.postMessage(sanitizeEmailHtml(html)),
  );
}
