import type { Header } from "postal-mime";

/** authserv-ids whose Authentication-Results header is trusted. Confirmed on real mail in PR 2. */
export const TRUSTED_AUTHSERV_IDS: readonly string[] = ["mx.cloudflare.net"];

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
  let mailfromSpf: string | undefined;
  for (const part of resinfo) {
    const match = /^\s*(spf|dkim|dmarc)\s*=\s*([a-z]+)/i.exec(part);
    if (!match?.[1] || !match[2]) continue;
    const method = match[1].toLowerCase() as keyof AuthResults;
    const value = match[2].toLowerCase();
    if (!RESULTS.has(value)) continue;
    // Cloudflare reports SPF for HELO and for MAIL FROM; only MAIL FROM is the one DMARC uses.
    if (method === "spf" && /\bsmtp\.mailfrom\s*=/i.test(part))
      mailfromSpf ??= value;
    // First result per method wins (a message can carry several DKIM signatures).
    if (results[method] === "unknown") results[method] = value;
  }
  if (mailfromSpf) results.spf = mailfromSpf;
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
