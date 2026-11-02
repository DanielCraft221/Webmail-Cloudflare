import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SKIP = new Set([
  "node_modules",
  ".svelte-kit",
  "build",
  "test-results",
  "playwright-report",
]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

// This file names the patterns, so it is the one file left out.
const all = files(ROOT)
  .map((path) => relative(ROOT, path))
  .filter((path) => path !== "test/forbidden-patterns.test.ts");
const code = all.filter((path) => /\.(ts|js|mjs|svelte|json)$/.test(path));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Each entry: why it is forbidden, and the files that break the rule. */
const rules: { name: string; why: string; offenders: () => string[] }[] = [
  {
    name: "{@html}",
    // The HTML of an email goes only into a sandboxed iframe (Etapa 6); {@html} skips Svelte's escaping.
    why: "XSS: inserts raw HTML into our own page",
    offenders: () =>
      code.filter((p) => p.endsWith(".svelte") && read(p).includes("{@html")),
  },
  {
    name: "src/params.* or src/params/",
    // Kit 3.1.1 advisory: a server-only import through src/params.js could end up in the client bundle.
    why: "server secrets could be inlined in the browser bundle (fixed only in kit 3.1.1)",
    offenders: () => all.filter((p) => /^src\/params(\.|\/)/.test(p)),
  },
  {
    name: "reroute hook",
    // Kit 3.1.1 advisory: reroute turning a malformed path into a valid one could crash adapter-node.
    why: "an unhandled URIError takes the whole server down (fixed only in kit 3.1.1)",
    offenders: () =>
      code.filter(
        (p) =>
          /(^|\/)hooks(\.server|\.client)?\.(ts|js)$/.test(p) &&
          /\breroute\b/.test(read(p)),
      ),
  },
  {
    name: "query/form/command/prerender from $app/server",
    // Kit 3.1.1 advisories: remote form parsing could block the event loop (DoS); private
    // query.batch functions could share a batch and mix their arguments.
    why: "experimental remote functions had a DoS and an argument mix-up (fixed only in kit 3.1.1)",
    offenders: () =>
      code.filter((p) =>
        /import\s*{[^}]*\b(query|form|command|prerender)\b[^}]*}\s*from\s*["']\$app\/server["']/.test(
          read(p),
        ),
      ),
  },
  {
    name: "router.resolution 'server'",
    // Kit 3.1.1 advisory: a //-prefixed path could make client navigation import code from another origin.
    why: "cross-origin script execution on client-side navigation (fixed only in kit 3.1.1)",
    offenders: () =>
      code.filter((p) => /resolution\s*:\s*["']server["']/.test(read(p))),
  },
  {
    name: "risky DOMPurify options",
    // docs/webmail-leitura.md: nearly every DOMPurify advisory since 2024 sits in one of these.
    why: "the source of most DOMPurify bypasses (IN_PLACE, SAFE_FOR_TEMPLATES, ...)",
    offenders: () =>
      code.filter((p) =>
        /\b(IN_PLACE|SAFE_FOR_TEMPLATES|CUSTOM_ELEMENT_HANDLING|RETURN_DOM|RETURN_DOM_FRAGMENT|RETURN_TRUSTED_TYPE|PARSER_MEDIA_TYPE|ADD_TAGS|ADD_ATTR|ADD_URI_SAFE_ATTR|USE_PROFILES|setConfig)\b/.test(
          read(p),
        ),
      ),
  },
  {
    name: "jsdom that runs scripts or loads resources",
    // jsdom's README: its sandbox "is not foolproof"; it only parses here, DOMPurify decides.
    why: "untrusted email code would run inside the server",
    offenders: () =>
      code.filter((p) => /\b(runScripts|resources)\s*:/.test(read(p))),
  },
  {
    name: "srcdoc",
    // An iframe srcdoc inherits the page's CSP and origin: the body has its own route.
    why: "the email would share the webmail's origin and CSP",
    offenders: () => code.filter((p) => /\bsrcdoc\b/i.test(read(p))),
  },
];

describe("forbidden patterns in apps/webmail", () => {
  it("scans the app's own files", () => {
    expect(code).toContain("src/hooks.server.ts");
    expect(code).toContain("vite.config.ts");
  });
  it.each(rules)("$name ($why)", ({ offenders }) => {
    expect(offenders()).toEqual([]);
  });
});
