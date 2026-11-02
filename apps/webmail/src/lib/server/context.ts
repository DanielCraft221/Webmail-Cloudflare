import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { dev } from "$app/env";
import { type Config, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { hashPassword } from "./password.ts";
import { type WebmailApi, webmailApi } from "./worker-api.ts";

export interface AppContext {
  config: Config;
  db: DatabaseSync;
  api: WebmailApi;
  dummyHash: string;
}

let context: AppContext | undefined;

/** Called from the init hook: a bad config stops the server before it listens. */
export async function initContext(): Promise<AppContext> {
  if (context) return context;
  // Every build is production; only `vite dev` is not.
  const config = loadConfig(!dev);
  context = {
    config,
    db: openDb(),
    api: webmailApi(config.api),
    dummyHash: await hashPassword(randomBytes(32).toString("base64")),
  };
  return context;
}

export function ctx(): AppContext {
  if (!context) throw new Error("context not initialized");
  return context;
}
