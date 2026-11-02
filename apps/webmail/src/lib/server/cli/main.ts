import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { api as schema } from "@webmail/shared";
import type { z } from "zod";
import { defaultDbPath, openDb } from "../db.ts";
import { ipKey, parseIp } from "../ip.ts";
import { addBan, clearUser, listBans, removeBan } from "../limits.ts";
import {
  deleteSessionById,
  deleteUserSessions,
  listSessions,
} from "../sessions.ts";
import { setupTokenHash } from "../setup.ts";
import { type ApiConfig, call, checkApiUrl } from "../worker-api.ts";
import { DEFAULT_ADMIN_ENV, readAdminEnv } from "./admin-env.ts";
import { clean, table, time } from "./output.ts";

const USAGE = `Uso: pnpm admin <comando>

  user:create <username> [--role admin|user] [--name "Nome"]
  user:list
  user:reset <username>
  user:disable <username> | user:enable <username>
  user:role <username> <admin|user>
  sessions:list [username] | sessions:revoke <username|id>
  ban:list | ban:remove <ip> | ban:add <ip> [--hours N]
  lock:clear <username>
  audit:list [--limit N]

Lê ADMIN_API_TOKEN e o Service Token de ~/.config/webmail/admin.env (chmod 600).`;

class UsageError extends Error {}

interface Cli {
  api: ApiConfig;
  origin: string;
  db: () => DatabaseSync;
  out: (text: string) => void;
}

function load(): Cli {
  const env = readAdminEnv(process.env.WEBMAIL_ADMIN_ENV || DEFAULT_ADMIN_ENV);
  const need = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`Missing ${name} in admin.env`);
    return value;
  };
  let db: DatabaseSync | undefined;
  return {
    api: {
      apiUrl: checkApiUrl(
        env.MAIL_API_URL || "https://mail-api.survivus.com.br",
      ),
      bearer: need("ADMIN_API_TOKEN"),
      accessClientId: need("CF_ACCESS_CLIENT_ID"),
      accessClientSecret: need("CF_ACCESS_CLIENT_SECRET"),
    },
    // WEBMAIL_ORIGIN=http://localhost:5173 for links to the dev server (docs/admin-cli.md).
    origin: new URL(
      process.env.WEBMAIL_ORIGIN ||
        env.WEBMAIL_ORIGIN ||
        "https://webmail.survivus.com.br",
    ).origin,
    db: () => {
      db ??= openDb(env.WEBMAIL_DB_PATH || defaultDbPath());
      return db;
    },
    out: (text) => process.stdout.write(`${text}\n`),
  };
}

async function admin<T extends z.ZodType>(
  cli: Cli,
  method: string,
  path: string,
  options: { body?: unknown; schema?: T; okStatus?: number },
) {
  const result = await call(cli.api, method, path, options);
  if (result.status === 401)
    throw new Error(
      "API answered 401: check ADMIN_API_TOKEN and the Service Token",
    );
  return result;
}

async function findUser(cli: Cli, username: string) {
  const { data } = await admin(cli, "GET", "/v1/admin/users", {
    schema: schema.adminUsersResponse,
  });
  const user = data?.users.find(
    (u) => u.username === username.trim().toLowerCase(),
  );
  if (!user) throw new Error(`User not found: ${clean(username)}`);
  return user;
}

async function localAudit(
  cli: Cli,
  body: { action: string; target?: string; detail?: Record<string, unknown> },
) {
  await admin(cli, "POST", "/v1/admin/audit", {
    body: schema.cliAuditBody.parse(body),
    okStatus: 204,
  });
}

function newLink(cli: Cli) {
  const token = randomBytes(32).toString("base64url");
  const hash = setupTokenHash(token);
  if (!hash) throw new Error("token generation failed");
  return { hash, link: `${cli.origin}/setup/${token}` };
}

/** The link is a 24-hour secret: shown once, on stdout only, never logged. */
function showLink(cli: Cli, link: string) {
  cli.out(
    `\nLink de configuração (vale 24 h, uso único). Mande por um canal seguro:\n\n  ${link}\n`,
  );
}

function arg(positionals: string[], index: number, what: string): string {
  const value = positionals[index];
  if (!value) throw new UsageError(`Faltou ${what}`);
  return value;
}

export async function run(
  argv: string[],
  loadCli: () => Cli = load,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      role: { type: "string" },
      name: { type: "string" },
      hours: { type: "string" },
      limit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command] = positionals;
  if (!command || values.help) {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  const cli = loadCli();
  const now = Date.now();

  switch (command) {
    case "user:create": {
      const username = arg(positionals, 1, "o username");
      const { hash, link } = newLink(cli);
      const body = schema.createUserBody.parse({
        username,
        role: values.role ?? "user",
        ...(values.name ? { displayName: values.name } : {}),
        setupTokenHash: hash,
      });
      const { status, data } = await admin(cli, "POST", "/v1/admin/users", {
        body,
        schema: schema.adminUser,
        okStatus: 201,
      });
      if (status === 409)
        throw new Error(`Username already exists: ${clean(username)}`);
      cli.out(
        `Usuário criado: ${clean(data?.username)} (${clean(data?.role)})`,
      );
      showLink(cli, link);
      return 0;
    }
    case "user:list": {
      const { data } = await admin(cli, "GET", "/v1/admin/users", {
        schema: schema.adminUsersResponse,
      });
      const rows = (data?.users ?? []).map((u) => ({
        username: u.username,
        nome: u.displayName,
        papel: u.role,
        ativo: u.active ? "sim" : "não",
        senha: u.hasPassword ? "sim" : "não",
        "2fa": u.hasTotp ? "sim" : "não",
        link_ate: u.setupExpiresAt,
      }));
      cli.out(
        table(rows, [
          "username",
          "nome",
          "papel",
          "ativo",
          "senha",
          "2fa",
          "link_ate",
        ]),
      );
      return 0;
    }
    case "user:reset": {
      const user = await findUser(cli, arg(positionals, 1, "o username"));
      const { hash, link } = newLink(cli);
      const { status } = await admin(
        cli,
        "POST",
        `/v1/admin/users/${user.id}/reset`,
        {
          body: { setupTokenHash: hash },
          schema: schema.adminUser,
        },
      );
      if (status === 404) throw new Error("User not found");
      const db = cli.db();
      const dropped = deleteUserSessions(db, user.id);
      db.prepare("DELETE FROM totp_used WHERE user_id = ?").run(user.id);
      cli.out(
        `Senha e 2FA de ${clean(user.username)} apagados. Sessões derrubadas: ${dropped}.`,
      );
      showLink(cli, link);
      return 0;
    }
    case "user:disable":
    case "user:enable": {
      const user = await findUser(cli, arg(positionals, 1, "o username"));
      const active = command === "user:enable";
      await admin(cli, "PATCH", `/v1/admin/users/${user.id}`, {
        body: { active },
        schema: schema.adminUser,
      });
      const dropped = active ? 0 : deleteUserSessions(cli.db(), user.id);
      cli.out(
        `${clean(user.username)} ${active ? "reativado" : `desativado. Sessões derrubadas: ${dropped}`}.`,
      );
      return 0;
    }
    case "user:role": {
      const user = await findUser(cli, arg(positionals, 1, "o username"));
      const role = schema.role.parse(
        arg(positionals, 2, "o papel (admin ou user)"),
      );
      await admin(cli, "PATCH", `/v1/admin/users/${user.id}`, {
        body: { role },
        schema: schema.adminUser,
      });
      cli.out(`${clean(user.username)} agora é ${role}.`);
      return 0;
    }
    case "sessions:list": {
      const rows = listSessions(cli.db(), positionals[1]?.toLowerCase()).map(
        (s) => ({
          id: s.id,
          username: s.username,
          ip: s.ip,
          criada: time(s.created_at),
          ultimo_uso: time(s.last_seen_at),
        }),
      );
      cli.out(table(rows, ["id", "username", "ip", "criada", "ultimo_uso"]));
      return 0;
    }
    case "sessions:revoke": {
      const target = arg(positionals, 1, "o username ou o id da sessão");
      let count: number;
      if (/^[0-9a-f]{12}$/.test(target))
        count = deleteSessionById(cli.db(), target);
      else
        count = deleteUserSessions(cli.db(), (await findUser(cli, target)).id);
      await localAudit(cli, {
        action: "session_revoke",
        target,
        detail: { count },
      });
      cli.out(`Sessões derrubadas: ${count}.`);
      return 0;
    }
    case "ban:list": {
      const rows = listBans(cli.db(), now).map((b) => ({
        ip: b.ip_key,
        ate: time(b.until),
        desde: time(b.created_at),
        motivo: b.reason,
      }));
      cli.out(table(rows, ["ip", "ate", "desde", "motivo"]));
      return 0;
    }
    case "ban:add":
    case "ban:remove": {
      const raw = arg(positionals, 1, "o IP");
      const ip = parseIp(raw);
      if (!ip) throw new UsageError(`IP inválido: ${clean(raw)}`);
      const key = ipKey(ip);
      if (command === "ban:remove") {
        const removed = removeBan(cli.db(), key);
        await localAudit(cli, {
          action: "ip_unban",
          target: key,
          detail: { removed },
        });
        cli.out(
          removed ? `Ban removido: ${key}` : `Nenhum ban ativo para ${key}.`,
        );
        return 0;
      }
      const hours = Number(values.hours ?? 24);
      if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 365)
        throw new UsageError("--hours entre 1 e 8760");
      addBan(cli.db(), key, now, hours * 3_600_000, "cli");
      await localAudit(cli, {
        action: "ip_ban",
        target: key,
        detail: { hours },
      });
      cli.out(`Banido por ${hours} h: ${key}`);
      return 0;
    }
    case "lock:clear": {
      const username = arg(positionals, 1, "o username").trim().toLowerCase();
      // The global lock and the lock of every IP block.
      const cleared = clearUser(cli.db(), username);
      await localAudit(cli, {
        action: "username_unlock",
        target: username,
        detail: { cleared },
      });
      cli.out(
        cleared
          ? `Bloqueio removido: ${clean(username)}`
          : `${clean(username)} não estava bloqueado.`,
      );
      return 0;
    }
    case "audit:list": {
      const limit = schema.auditListQuery.parse({ limit: values.limit }).limit;
      const { data } = await admin(
        cli,
        "GET",
        `/v1/admin/audit?limit=${limit}`,
        { schema: schema.auditListResponse },
      );
      const rows = (data?.events ?? []).map((e) => ({
        quando: e.createdAt.replace("T", " ").slice(0, 19),
        origem: e.source,
        acao: e.action,
        usuario: e.actorUserId,
        alvo: e.target,
        ip: e.ip,
        detalhe: e.detail ? JSON.stringify(e.detail) : null,
      }));
      cli.out(
        table(rows, [
          "quando",
          "origem",
          "acao",
          "usuario",
          "alvo",
          "ip",
          "detalhe",
        ]),
      );
      return 0;
    }
    default:
      throw new UsageError(`Comando desconhecido: ${clean(command)}`);
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Only the message: never the request, its headers or the admin.env content.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Erro: ${clean(message)}\n`);
      if (err instanceof UsageError) process.stderr.write(`\n${USAGE}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    },
  );
}
