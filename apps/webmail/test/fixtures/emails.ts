/**
 * Hostile and ordinary emails for the reading tests (unit, fake Worker, HTTP and Firefox).
 * Every external address is under .example (never resolves); the browser test fails on any
 * request that leaves localhost, so each line here is an attempt the three layers must stop.
 */

/** The fake Worker's echo route: the one link the browser test may open. */
export const ECHO_URL = "http://127.0.0.1:8790/__echo/referer";

export const MALICIOUS_HTML = `<!doctype html>
<html><head>
<base href="https://evil.example/">
<meta http-equiv="refresh" content="0;url=https://evil.example/refresh">
<link rel="stylesheet" href="https://evil.example/link.css">
<style>
@import url(https://evil.example/import.css);
@import "https://evil.example/import2.css";
@font-face { font-family: x; src: url(https://evil.example/font.woff); }
.a { background: url(https://evil.example/css-url.png); }
.b { background: ur/**/l(https://evil.example/comment.png); }
.c { background: \\75 rl(https://evil.example/escape.png); }
.d { background: url( "https://evil.example/quoted spaces.png" ); }
.e { background-image: image-set("https://evil.example/set.png" 1x); }
.f { color: red; }
</style>
<script>alert("head script")</script>
</head>
<body onload="alert('onload')" background="https://evil.example/body-bg.png">
<p class="f" id="greeting">Olá, esta é uma mensagem de teste.</p>
<script>alert("body script")</script>
<img src="x" onerror="alert('onerror')">
<img src="https://tracker.example/open.gif" width="1" height="1">
<img srcset="https://evil.example/srcset.png 2x" alt="srcset">
<svg><script>alert("svg")</script><image href="https://evil.example/svg.png"/></svg>
<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert('mxss')&gt;"></mglyph></table></mtext></math>
<a href="javascript:alert('js link')">link javascript</a>
<a href="data:text/html,<script>alert('data')</script>">link data</a>
<a href="vbscript:msgbox('vb')">link vbscript</a>
<a href="java&#x09;script:alert('tab')">link com tab</a>
<form action="https://evil.example/phish"><input name="senha"><button formaction="https://evil.example/f">Enviar</button></form>
<iframe src="https://evil.example/frame"></iframe>
<object data="https://evil.example/obj"></object>
<embed src="https://evil.example/embed">
<div style="background:url(https://evil.example/inline.png)">fundo inline</div>
<div style="background: ur/**/l(https://evil.example/inline-comment.png)">fundo com comentário</div>
<div style="background: \\75 rl(https://evil.example/inline-escape.png)">fundo com escape</div>
<div style="background-image: url( 'https://evil.example/inline quoted.png' )">fundo com aspas</div>
<table background="https://evil.example/table-bg.png"><tr><td>tabela</td></tr></table>
<a id="safe-link" href="${ECHO_URL}">link normal</a>
</body></html>`;

/** Known mutation-XSS shapes (from DOMPurify's own tests and advisories): each must come out inert. */
export const MXSS_VECTORS = [
  `<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">`,
  `<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;">`,
  `<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>`,
  `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<xmp><p title="</xmp><img src=x onerror=alert(1)>">`,
  `<noembed><p title="</noembed><img src=x onerror=alert(1)>">`,
  `<template><style></template><img src=x onerror=alert(1)></style></template>`,
  `<table><caption><svg><title><style></style></title></svg></caption></table><img src=x onerror=alert(1)>`,
  `<a href="&#106;avascript:alert(1)">x</a>`,
  `<a href=" javascript:alert(1)">x</a>`,
  `<a href="JaVaScRiPt:alert(1)">x</a>`,
  `<div><a href="java\u0000script:alert(1)">x</a></div>`,
];

/** About 1.1 MB of HTML: above MAX_HTML_BYTES, shown as text. */
export const LARGE_HTML = `<html><body>${"<p>linha de newsletter grande</p>".repeat(36_000)}</body></html>`;

/** Just under 1 MB, with styles: slow enough (over a second) to hold a worker during the 503 test. */
export const SLOW_HTML = `<html><body><table>${'<tr><td style="padding:4px;color:#333"><b>x</b> <a href="https://a.example/">a</a></td></tr>'.repeat(10_500)}</table></body></html>`;

/** Fixed ids of the fake Worker's messages (test/fake-worker.ts). Mailbox 1 is readable by every user; mailbox 2 by none. */
export const MSG = {
  malicious: "00000000-0000-4000-8000-000000000001",
  textOnly: "00000000-0000-4000-8000-000000000002",
  large: "00000000-0000-4000-8000-000000000003",
  slow: "00000000-0000-4000-8000-000000000004",
  otherMailbox: "00000000-0000-4000-8000-000000000005",
  unparsed: "00000000-0000-4000-8000-000000000006",
  missing: "00000000-0000-4000-8000-0000000000ff",
  htmlAttachment: "00000000-0000-4000-8000-0000000000a1",
  trickyName: "00000000-0000-4000-8000-0000000000a2",
} as const;

/** Declared as text/html by the sender: must download as octet-stream, never render. */
export const HTML_ATTACHMENT = `<script>alert("attachment")</script>`;
/** Quotes, a line break, a path and accents: the Content-Disposition must stay one safe header. */
export const TRICKY_NAME = 'fatura "final"\r\n../../relatório ação.html';
