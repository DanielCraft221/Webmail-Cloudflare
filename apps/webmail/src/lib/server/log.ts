type Value = string | number | boolean | null;

/**
 * One JSON line per event. Callers pass only safe fields: never a password, code, link token,
 * session token, cookie, Authorization header or .env content (tested in e2e/logs.spec.ts).
 */
export function log(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, Value> = {},
) {
  const line = JSON.stringify({
    level,
    event,
    ...fields,
    time: new Date().toISOString(),
  });
  (level === "info" ? console.log : console.error)(line);
}
