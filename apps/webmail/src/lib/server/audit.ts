import type { DatabaseSync } from "node:sqlite";
import { ipKey } from "./ip.ts";
import { ipFailure } from "./limits.ts";
import { log } from "./log.ts";
import type { WebmailApi } from "./worker-api.ts";

/** Fire and forget: an API hiccup must not change the answer the person gets. */
export function audit(
  api: WebmailApi,
  body: Parameters<WebmailApi["audit"]>[0],
) {
  api
    .audit(body)
    .catch(() => log("error", "audit_failed", { action: body.action }));
}

/** Counts a failure for the IP (login or /setup) and audits the ban it may start. Returns the ban length in ms or null. */
export function recordIpFailure(
  db: DatabaseSync,
  api: WebmailApi,
  ip: string,
  now: number,
): number | null {
  const key = ipKey(ip);
  const banLength = ipFailure(db, key, now);
  if (banLength !== null)
    audit(api, {
      action: "ip_ban",
      ip,
      target: key,
      detail: { minutes: banLength / 60_000 },
    });
  return banLength;
}
