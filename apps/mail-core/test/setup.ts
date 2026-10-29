import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import survivus from "../seed/0001_survivus.sql?raw";
import daniel from "../seed/0002_danielcraft221.sql?raw";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const statements = [survivus, daniel]
  .join(";")
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.replace(/--.*$/gm, "").trim());
await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
