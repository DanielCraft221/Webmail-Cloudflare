import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ADMIN_ENV = join(homedir(), ".config/webmail/admin.env");

/**
 * KEY=VALUE lines from admin.env. The file is read, never sourced, and must be 600 and ours:
 * it holds the ADMIN_API_TOKEN, which never comes from a command-line argument.
 */
export function readAdminEnv(path: string): Record<string, string> {
  const stat = statSync(path);
  if ((stat.mode & 0o777) !== 0o600)
    throw new Error(
      `${path} must have permission 600 (it has ${(stat.mode & 0o777).toString(8)})`,
    );
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error(`${path} must belong to the user running the CLI`);
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1]) env[match[1]] = (match[2] ?? "").trim();
  }
  return env;
}
