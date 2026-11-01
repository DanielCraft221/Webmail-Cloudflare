/**
 * Fake mail-core for the webmail tests: the auth, audit and admin routes of docs/api.md, with
 * the same token groups and the shared zod schemas. Never the real API, never real secrets.
 * Run alone with `node test/fake-worker.ts` (PORT, default 8790).
 */
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { api } from "@webmail/shared";
import type { z } from "zod";
import { FAKE } from "./fake-tokens.ts";

export { FAKE };

interface User {
  id: string;
  username: string;
  displayName: string | null;
  role: "admin" | "user";
  active: boolean;
  passwordHash: string | null;
  totpSecretEnc: string | null;
  setupTokenHash: string | null;
  setupExpiresAt: number | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface Store {
  users: Map<string, User>;
  audit: z.infer<typeof api.auditEvent>[];
}

const DAY = 86_400_000;

export function createStore(): Store {
  return { users: new Map(), audit: [] };
}

function adminUser(u: User) {
  return api.adminUser.parse({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    active: u.active,
    hasPassword: u.passwordHash !== null,
    hasTotp: u.totpSecretEnc !== null,
    setupExpiresAt:
      u.setupExpiresAt && u.setupExpiresAt > Date.now()
        ? new Date(u.setupExpiresAt).toISOString()
        : null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  });
}

function record(
  store: Store,
  event: Omit<z.infer<typeof api.auditEvent>, "id" | "createdAt">,
) {
  store.audit.push({
    id: store.audit.length + 1,
    createdAt: new Date().toISOString(),
    ...event,
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

const ERRORS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  404: "not_found",
  409: "conflict",
};

export function handler(store: Store) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const fail = (status: number) =>
      send(res, status, { error: ERRORS[status] });
    if (path === "/health") return send(res, 200, { ok: true });

    // Access in front, then the bearer of the route's group (docs/api.md).
    if (
      req.headers["cf-access-client-id"] !== FAKE.accessId ||
      req.headers["cf-access-client-secret"] !== FAKE.accessSecret
    )
      return fail(401);
    const group = path.startsWith("/v1/admin/")
      ? "admin"
      : path.startsWith("/v1/auth/") || path === "/v1/audit"
        ? "service"
        : "user";
    const bearer = req.headers.authorization;
    const expected = group === "admin" ? FAKE.adminToken : FAKE.internalToken;
    if (bearer !== `Bearer ${expected}`) return fail(401);

    const body = method === "GET" ? null : await readJson(req);
    const parse = <T extends z.ZodType>(schema: T): z.infer<T> | null => {
      const result = schema.safeParse(body);
      return result.success ? result.data : null;
    };
    const byName = (name: string) =>
      [...store.users.values()].find((u) => u.username === name);
    const byToken = (hash: string) =>
      [...store.users.values()].find(
        (u) =>
          u.setupTokenHash === hash &&
          u.active &&
          (u.setupExpiresAt ?? 0) > Date.now(),
      );

    if (group === "user") {
      const user = store.users.get(String(req.headers["x-webmail-user"] ?? ""));
      // Disabled, or reset and not configured again: 401, like the real Worker.
      if (!user?.active || !user.passwordHash || !user.totpSecretEnc)
        return fail(401);
      if (method === "GET" && path === "/v1/me")
        return send(res, 200, {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          updatedAt: user.updatedAt,
        });
      return fail(404);
    }

    if (method === "POST" && path === "/v1/auth/lookup") {
      const b = parse(api.authLookupBody);
      if (!b) return fail(400);
      const u = byName(b.username);
      if (!u) return fail(404);
      return send(res, 200, {
        id: u.id,
        active: u.active,
        role: u.role,
        passwordHash: u.passwordHash,
        totpSecretEnc: u.totpSecretEnc,
      });
    }
    if (method === "POST" && path === "/v1/auth/setup/lookup") {
      const b = parse(api.setupLookupBody);
      if (!b) return fail(400);
      const u = byToken(b.tokenHash);
      return u ? send(res, 200, { id: u.id, username: u.username }) : fail(404);
    }
    if (method === "POST" && path === "/v1/auth/setup/complete") {
      const b = parse(api.setupCompleteBody);
      if (!b) return fail(400);
      // Single synchronous check-and-write, like the conditional UPDATE in D1.
      const u = byToken(b.tokenHash);
      if (!u) return fail(404);
      Object.assign(u, {
        passwordHash: b.passwordHash,
        totpSecretEnc: b.totpSecretEnc,
        setupTokenHash: null,
        setupExpiresAt: null,
        updatedAt: new Date().toISOString(),
      });
      return send(res, 200, { id: u.id, username: u.username });
    }
    if (method === "POST" && path === "/v1/audit") {
      const b = parse(api.webmailAuditBody);
      if (!b) return fail(400);
      const actor =
        b.actorUserId && store.users.has(b.actorUserId) ? b.actorUserId : null;
      record(store, {
        source: "webmail",
        actorUserId: actor,
        action: b.action,
        target: b.target ?? null,
        ip: b.ip ?? null,
        detail: b.detail ?? null,
      });
      return send(res, 204);
    }

    if (method === "GET" && path === "/v1/admin/users")
      return send(res, 200, {
        users: [...store.users.values()]
          .sort((a, b) => a.username.localeCompare(b.username))
          .map(adminUser),
      });
    if (method === "POST" && path === "/v1/admin/users") {
      const b = parse(api.createUserBody);
      if (!b) return fail(400);
      if (byName(b.username)) return fail(409);
      const u: User = {
        id: randomUUID(),
        username: b.username,
        displayName: b.displayName ?? null,
        role: b.role,
        active: true,
        passwordHash: null,
        totpSecretEnc: null,
        setupTokenHash: b.setupTokenHash,
        setupExpiresAt: Date.now() + DAY,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      store.users.set(u.id, u);
      record(store, {
        source: "cli",
        actorUserId: null,
        action: "user_create",
        target: null,
        ip: null,
        detail: { username: u.username, role: u.role },
      });
      return send(res, 201, adminUser(u));
    }
    const userRoute = /^\/v1\/admin\/users\/([^/]+)(\/reset)?$/.exec(path);
    if (userRoute) {
      const u = store.users.get(userRoute[1] ?? "");
      if (!u) return fail(404);
      if (method === "POST" && userRoute[2]) {
        const b = parse(api.resetUserBody);
        if (!b) return fail(400);
        Object.assign(u, {
          passwordHash: null,
          totpSecretEnc: null,
          setupTokenHash: b.setupTokenHash,
          setupExpiresAt: Date.now() + DAY,
          updatedAt: new Date().toISOString(),
        });
        record(store, {
          source: "cli",
          actorUserId: u.id,
          action: "user_reset",
          target: null,
          ip: null,
          detail: null,
        });
        return send(res, 200, adminUser(u));
      }
      if (method === "PATCH" && !userRoute[2]) {
        const b = parse(api.patchUserBody);
        if (!b) return fail(400);
        if (b.active !== undefined) u.active = b.active;
        if (b.role !== undefined) u.role = b.role;
        if (b.displayName !== undefined) u.displayName = b.displayName;
        u.updatedAt = new Date().toISOString();
        record(store, {
          source: "cli",
          actorUserId: u.id,
          action: "user_update",
          target: null,
          ip: null,
          detail: null,
        });
        return send(res, 200, adminUser(u));
      }
    }
    if (method === "GET" && path === "/v1/admin/audit") {
      const q = api.auditListQuery.safeParse({
        limit: url.searchParams.get("limit") ?? undefined,
      });
      if (!q.success) return fail(400);
      return send(res, 200, {
        events: [...store.audit].reverse().slice(0, q.data.limit),
      });
    }
    if (method === "POST" && path === "/v1/admin/audit") {
      const b = parse(api.cliAuditBody);
      if (!b) return fail(400);
      record(store, {
        source: "cli",
        actorUserId: null,
        action: b.action,
        target: b.target ?? null,
        ip: null,
        detail: b.detail ?? null,
      });
      return send(res, 204);
    }
    return fail(404);
  };
}

export async function startFakeWorker(port = 0, store = createStore()) {
  const server = createServer(handler(store));
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actual}`,
    store,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

if (import.meta.main) {
  const { url } = await startFakeWorker(Number(process.env.PORT ?? 8790));
  console.log(`fake mail-core on ${url}`);
}
