import type { Header } from "postal-mime";

/**
 * authserv-ids whose Authentication-Results header is trusted. Empty until PR 2 confirms,
 * on a real message, the value Cloudflare writes: until then every result is "unknown".
 */
export const TRUSTED_AUTHSERV_IDS: readonly string[] = [];

export type AuthResults = { spf: string; dkim: string; dmarc: string };

const UNKNOWN: AuthResults = {
  spf: "unknown",
  dkim: "unknown",
  dmarc: "unknown",
};
const RESULTS = new Set([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
]);

/** RFC 8601. `headers` must be in message order (postal-mime keeps it). */
export function parseAuthenticationResults(
  headers: readonly Header[],
  trusted: readonly string[] = TRUSTED_AUTHSERV_IDS,
): AuthResults {
  // Only the topmost header can come from Cloudflare: anything below it may be forged by the sender.
  const top = headers.find((h) => h.key === "authentication-results");
  if (!top) return UNKNOWN;

  const [authserv = "", ...resinfo] = stripComments(top.value).split(";");
  const authservId = authserv.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!trusted.includes(authservId)) return UNKNOWN;

  const results = { ...UNKNOWN };
  for (const part of resinfo) {
    const match = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(part);
    if (!match?.[1] || !match[2]) continue;
    const method = match[1].toLowerCase() as keyof AuthResults;
    const value = match[2].toLowerCase();
    // First result per method wins (a message can carry several DKIM signatures).
    if (results[method] === "unknown" && RESULTS.has(value))
      results[method] = value;
  }
  return results;
}

/** Removes RFC 5322 comments in one pass, so deeply nested parentheses cannot burn CPU. */
function stripComments(value: string): string {
  let depth = 0;
  let out = "";
  for (const char of value) {
    if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    else if (depth === 0) out += char;
  }
  return out;
}
