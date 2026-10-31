import { api as schema } from "@webmail/shared";
import { type Context, Hono } from "hono";
import { routePath } from "hono/route";
import { type AccessKeys, verifyAccessJwt } from "./access";
import { errorName, log } from "./log";

type Api = { Bindings: Env; Variables: { userId: string } };

export const SEARCH_LIMIT = 50;
const RECEIVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type MessageRow = {
  id: string;
  mailbox_id: number;
  folder: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_ids: string | null;
  from_address: string | null;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  subject: string | null;
  snippet: string | null;
  header_date: string | null;
  received_at: string;
  size: number;
  has_attachments: number;
  spf: string;
  dkim: string;
  dmarc: string;
  is_read: number;
  raw_key: string;
  body_key: string | null;
  parse_status: string;
};

type AttachmentRow = {
  id: string;
  filename: string | null;
  content_type: string;
  size: number;
  r2_key: string;
  content_id: string | null;
  is_inline: number;
};

/** Called by the webmail with the internal token but without X-Webmail-User: nobody is logged in yet. */
const SERVICE_ROUTES = new Set([
  "/v1/auth/lookup",
  "/v1/auth/setup/lookup",
  "/v1/auth/setup/complete",
  "/v1/audit",
]);

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const SETUP_EXPIRES = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours')";

const SUMMARY_COLUMNS = `m.id, m.mailbox_id, m.folder, m.from_address, m.from_name, m.subject, m.snippet,
  m.header_date, m.received_at, m.size, m.has_attachments, m.spf, m.dkim, m.dmarc, m.is_read, m.parse_status`;

/**
 * The internal API for the webmail (docs/api.md). `keys` is the Access key source:
 * src/index.ts passes the real one; only test code passes another.
 */
export function createApi(keys: AccessKeys): Hono<Api> {
  const app = new Hono<Api>();

  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    if (!c.res.headers.has("Cache-Control"))
      c.res.headers.set("Cache-Control", "no-store");
    // Route pattern only: no ids, no query string, nothing the client typed.
    log({
      event: "api_request",
      route: `${c.req.method} ${routePath(c, -1)}`,
      ...(c.get("userId") ? { user: c.get("userId") } : {}),
      httpStatus: c.res.status,
      ms: Date.now() - start,
    });
  });

  app.use("/v1/*", async (c, next) => {
    const env = c.env;
    const jwtOk = await verifyAccessJwt(
      c.req.header("Cf-Access-Jwt-Assertion"),
      {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUD,
        clientId: env.ACCESS_CLIENT_ID,
      },
      keys,
    );
    if (!jwtOk) return error(c, 401, "unauthorized");

    // Decided by the matched route pattern, never by the raw path: an encoded or doubled
    // slash cannot change the group. Unknown routes get the strictest group and end in 404.
    const route = routePath(c, -1);
    const group = route.startsWith("/v1/admin/")
      ? "admin"
      : SERVICE_ROUTES.has(route)
        ? "service"
        : "user";
    const expected =
      group === "admin" ? env.ADMIN_API_TOKEN : env.INTERNAL_API_TOKEN;
    const bearer = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
    if (!bearer?.[1] || !expected || !(await sameSecret(bearer[1], expected)))
      return error(c, 401, "unauthorized");

    let rateKey: string = group;
    if (group === "user") {
      const userId = schema.messageId.safeParse(c.req.header("X-Webmail-User"));
      if (!userId.success) return error(c, 401, "unauthorized");
      const user = await env.DB.prepare(
        "SELECT id FROM users WHERE id = ?1 AND active = 1",
      )
        .bind(userId.data)
        .first<{ id: string }>();
      if (!user) return error(c, 401, "unauthorized");
      c.set("userId", user.id);
      rateKey = user.id;
    }

    const { success } = await env.API_RATE_LIMIT.limit({ key: rateKey });
    if (!success) return error(c, 429, "rate_limited");
    await next();
  });

  app.get("/v1/mailboxes", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT b.id, b.address, b.display_name, m.folder, COUNT(m.id) AS unread
       FROM user_mailboxes p
       JOIN mailboxes b ON b.id = p.mailbox_id
       LEFT JOIN messages m ON m.mailbox_id = b.id AND m.is_read = 0
       WHERE p.user_id = ?1 AND p.can_read = 1
       GROUP BY b.id, m.folder
       ORDER BY b.address`,
    )
      .bind(c.get("userId"))
      .all<{
        id: number;
        address: string;
        display_name: string | null;
        folder: string | null;
        unread: number;
      }>();
    const mailboxes = new Map<
      number,
      {
        id: number;
        address: string;
        displayName: string | null;
        unread: Record<string, number>;
      }
    >();
    for (const row of results) {
      let mailbox = mailboxes.get(row.id);
      if (!mailbox) {
        mailbox = {
          id: row.id,
          address: row.address,
          displayName: row.display_name,
          unread: Object.fromEntries(schema.FOLDERS.map((f) => [f, 0])),
        };
        mailboxes.set(row.id, mailbox);
      }
      if (row.folder) mailbox.unread[row.folder] = row.unread;
    }
    return c.json({ mailboxes: [...mailboxes.values()] });
  });

  app.get("/v1/mailboxes/:id/messages", async (c) => {
    const id = schema.mailboxId.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found");
    const query = schema.listMessagesQuery.safeParse(c.req.query());
    if (!query.success) return error(c, 400, "bad_request");
    const cursor = query.data.cursor
      ? decodeCursor(query.data.cursor)
      : undefined;
    if (cursor === null) return error(c, 400, "bad_request");

    const allowed = await c.env.DB.prepare(
      "SELECT 1 FROM user_mailboxes WHERE user_id = ?1 AND mailbox_id = ?2 AND can_read = 1",
    )
      .bind(c.get("userId"), id.data)
      .first();
    if (!allowed) return error(c, 404, "not_found");

    const { limit, folder } = query.data;
    const { results } = await c.env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM messages m
       WHERE m.mailbox_id = ?1 AND m.folder = ?2
         AND (?3 IS NULL OR m.received_at < ?3 OR (m.received_at = ?3 AND m.id < ?4))
       ORDER BY m.received_at DESC, m.id DESC
       LIMIT ?5`,
    )
      .bind(
        id.data,
        folder,
        cursor?.receivedAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      )
      .all<MessageRow>();
    const page = results.slice(0, limit);
    const last = page.at(-1);
    return c.json({
      messages: page.map(summary),
      nextCursor:
        results.length > limit && last
          ? encodeCursor(last.received_at, last.id)
          : null,
    });
  });

  app.get("/v1/messages/:id", async (c) => {
    const message = await readableMessage(c, c.req.param("id"));
    if (!message) return error(c, 404, "not_found");
    const [body, attachments] = await Promise.all([
      message.body_key ? c.env.MAIL.get(message.body_key) : null,
      c.env.DB.prepare(
        "SELECT * FROM attachments WHERE message_id = ?1 ORDER BY rowid",
      )
        .bind(message.id)
        .all<AttachmentRow>(),
    ]);
    return c.json({
      ...summary(message),
      to: JSON.parse(message.to_json),
      cc: JSON.parse(message.cc_json),
      messageId: message.message_id,
      inReplyTo: message.in_reply_to,
      references: message.references_ids,
      // HTML stays data here: the webmail sanitizes it (Etapa 6).
      body: body ? await body.json() : null,
      attachments: attachments.results.map((a) => ({
        id: a.id,
        filename: a.filename,
        // As declared by the sender: never used in a response header.
        contentType: a.content_type,
        size: a.size,
        isInline: a.is_inline === 1,
        contentId: a.content_id,
      })),
    });
  });

  app.get("/v1/messages/:id/attachments/:attId", async (c) => {
    const message = await readableMessage(c, c.req.param("id"));
    const attId = schema.messageId.safeParse(c.req.param("attId"));
    if (!message || !attId.success) return error(c, 404, "not_found");
    // Scoped to the message just authorized: an attachment of another message is not found.
    const attachment = await c.env.DB.prepare(
      "SELECT * FROM attachments WHERE id = ?1 AND message_id = ?2",
    )
      .bind(attId.data, message.id)
      .first<AttachmentRow>();
    if (!attachment) return error(c, 404, "not_found");
    return download(c.env, attachment.r2_key, attachment.filename, "anexo");
  });

  app.get("/v1/messages/:id/raw", async (c) => {
    const message = await readableMessage(c, c.req.param("id"));
    if (!message) return error(c, 404, "not_found");
    return download(c.env, message.raw_key, `${message.id}.eml`, "mensagem");
  });

  app.patch("/v1/messages/:id", async (c) => {
    const message = await readableMessage(c, c.req.param("id"));
    if (!message) return error(c, 404, "not_found");
    const body = schema.patchMessageBody.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!body.success) return error(c, 400, "bad_request");
    const { isRead, folder } = body.data;
    const updated = await c.env.DB.prepare(
      `UPDATE messages SET is_read = COALESCE(?2, is_read), folder = COALESCE(?3, folder)
       WHERE id = ?1 RETURNING id, is_read, folder`,
    )
      .bind(
        message.id,
        isRead === undefined ? null : Number(isRead),
        folder ?? null,
      )
      .first<{ id: string; is_read: number; folder: string }>();
    if (!updated) return error(c, 404, "not_found");
    return c.json({
      id: updated.id,
      isRead: updated.is_read === 1,
      folder: updated.folder,
    });
  });

  app.post("/v1/search", async (c) => {
    const query = schema.searchBody.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!query.success) return error(c, 400, "bad_request");
    // % and _ are text, not wildcards.
    const pattern = `%${query.data.q.replace(/[\\%_]/g, "\\$&")}%`;
    const { results } = await c.env.DB.prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM messages m
       JOIN user_mailboxes p ON p.mailbox_id = m.mailbox_id AND p.user_id = ?1 AND p.can_read = 1
       WHERE (?2 IS NULL OR m.mailbox_id = ?2)
         AND (m.subject LIKE ?3 ESCAPE '\\' OR m.from_address LIKE ?3 ESCAPE '\\'
              OR m.from_name LIKE ?3 ESCAPE '\\')
       ORDER BY m.received_at DESC, m.id DESC
       LIMIT ?4`,
    )
      .bind(c.get("userId"), query.data.mailbox ?? null, pattern, SEARCH_LIMIT)
      .all<MessageRow>();
    return c.json({ messages: results.map(summary) });
  });

  // --- Authentication: the webmail verifies password and code itself (docs/webmail-auth.md) ---

  // The only response that carries a password hash and the encrypted TOTP secret: it exists for that.
  app.post("/v1/auth/lookup", async (c) => {
    const body = await jsonBody(c, schema.authLookupBody);
    if (!body.success) return error(c, 400, "bad_request");
    const user = await c.env.DB.prepare(
      `SELECT id, active, role, password_hash, totp_secret_enc FROM users WHERE username = ?1`,
    )
      .bind(body.data.username)
      .first<{
        id: string;
        active: number;
        role: string;
        password_hash: string | null;
        totp_secret_enc: string | null;
      }>();
    if (!user) return error(c, 404, "not_found");
    return c.json({
      id: user.id,
      active: user.active === 1,
      role: user.role,
      passwordHash: user.password_hash,
      totpSecretEnc: user.totp_secret_enc,
    });
  });

  app.post("/v1/auth/setup/lookup", async (c) => {
    const body = await jsonBody(c, schema.setupLookupBody);
    if (!body.success) return error(c, 400, "bad_request");
    const user = await c.env.DB.prepare(
      `SELECT id, username FROM users
       WHERE setup_token_hash = ?1 AND setup_expires_at > ${NOW} AND active = 1`,
    )
      .bind(body.data.tokenHash)
      .first<{ id: string; username: string }>();
    if (!user) return error(c, 404, "not_found");
    return c.json(user);
  });

  // One conditional UPDATE: of two concurrent calls with the same link, only one matches a row.
  app.post("/v1/auth/setup/complete", async (c) => {
    const body = await jsonBody(c, schema.setupCompleteBody);
    if (!body.success) return error(c, 400, "bad_request");
    const user = await c.env.DB.prepare(
      `UPDATE users SET password_hash = ?2, totp_secret_enc = ?3, setup_token_hash = NULL,
         setup_expires_at = NULL, updated_at = ${NOW}
       WHERE setup_token_hash = ?1 AND setup_expires_at > ${NOW} AND active = 1
       RETURNING id, username`,
    )
      .bind(
        body.data.tokenHash,
        body.data.passwordHash,
        body.data.totpSecretEnc,
      )
      .first<{ id: string; username: string }>();
    if (!user) return error(c, 404, "not_found");
    return c.json(user);
  });

  app.get("/v1/me", async (c) => {
    const user = await c.env.DB.prepare(
      "SELECT id, username, display_name, role FROM users WHERE id = ?1",
    )
      .bind(c.get("userId"))
      .first<{
        id: string;
        username: string;
        display_name: string | null;
        role: string;
      }>();
    if (!user) return error(c, 401, "unauthorized");
    return c.json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
    });
  });

  app.post("/v1/audit", async (c) => {
    const body = await jsonBody(c, schema.webmailAuditBody);
    if (!body.success) return error(c, 400, "bad_request");
    const { action, actorUserId, target, ip, detail } = body.data;
    // An unknown actor id is stored as NULL instead of failing the foreign key.
    await c.env.DB.prepare(
      `INSERT INTO audit_log (source, actor_user_id, action, target, ip, detail)
       VALUES ('webmail', (SELECT id FROM users WHERE id = ?1), ?2, ?3, ?4, ?5)`,
    )
      .bind(
        actorUserId ?? null,
        action,
        target ?? null,
        ip ?? null,
        detail ? JSON.stringify(detail) : null,
      )
      .run();
    return c.body(null, 204);
  });

  // --- Administration: ADMIN_API_TOKEN only, used by the CLI. Every route writes to audit_log ---

  app.get("/v1/admin/users", async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT ${ADMIN_USER_COLUMNS} FROM users ORDER BY username`,
    ).all<AdminUserRow>();
    await cliAudit(c, "user_list").run();
    return c.json({ users: results.map(adminUser) });
  });

  app.post("/v1/admin/users", async (c) => {
    const body = await jsonBody(c, schema.createUserBody);
    if (!body.success) return error(c, 400, "bad_request");
    const { username, role, displayName, setupTokenHash } = body.data;
    const id = crypto.randomUUID();
    try {
      const [created] = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO users (id, username, display_name, role, setup_token_hash, setup_expires_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ${SETUP_EXPIRES}, ${NOW})
           RETURNING ${ADMIN_USER_COLUMNS}`,
        ).bind(id, username, displayName ?? null, role, setupTokenHash),
        cliAudit(c, "user_create", { userId: id, detail: { username, role } }),
      ]);
      const row = created?.results[0] as AdminUserRow;
      return c.json(adminUser(row), 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint"))
        return error(c, 409, "conflict");
      throw err;
    }
  });

  app.post("/v1/admin/users/:id/reset", async (c) => {
    const id = schema.messageId.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found");
    const body = await jsonBody(c, schema.resetUserBody);
    if (!body.success) return error(c, 400, "bad_request");
    const [updated] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE users SET password_hash = NULL, totp_secret_enc = NULL, setup_token_hash = ?2,
           setup_expires_at = ${SETUP_EXPIRES}, updated_at = ${NOW}
         WHERE id = ?1 RETURNING ${ADMIN_USER_COLUMNS}`,
      ).bind(id.data, body.data.setupTokenHash),
      cliAudit(c, "user_reset", { userId: id.data }),
    ]);
    const row = updated?.results[0] as AdminUserRow | undefined;
    if (!row) return error(c, 404, "not_found");
    return c.json(adminUser(row));
  });

  app.patch("/v1/admin/users/:id", async (c) => {
    const id = schema.messageId.safeParse(c.req.param("id"));
    if (!id.success) return error(c, 404, "not_found");
    const body = await jsonBody(c, schema.patchUserBody);
    if (!body.success) return error(c, 400, "bad_request");
    const { active, role, displayName } = body.data;
    const [updated] = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE users SET active = COALESCE(?2, active), role = COALESCE(?3, role),
           display_name = CASE WHEN ?4 THEN ?5 ELSE display_name END, updated_at = ${NOW}
         WHERE id = ?1 RETURNING ${ADMIN_USER_COLUMNS}`,
      ).bind(
        id.data,
        active === undefined ? null : Number(active),
        role ?? null,
        Number(displayName !== undefined),
        displayName ?? null,
      ),
      cliAudit(c, "user_update", { userId: id.data, detail: body.data }),
    ]);
    const row = updated?.results[0] as AdminUserRow | undefined;
    if (!row) return error(c, 404, "not_found");
    return c.json(adminUser(row));
  });

  app.get("/v1/admin/audit", async (c) => {
    const query = schema.auditListQuery.safeParse(c.req.query());
    if (!query.success) return error(c, 400, "bad_request");
    const { results } = await c.env.DB.prepare(
      `SELECT id, created_at, source, actor_user_id, action, target, ip, detail
       FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?1`,
    )
      .bind(query.data.limit)
      .all<{
        id: number;
        created_at: string;
        source: string;
        actor_user_id: string | null;
        action: string;
        target: string | null;
        ip: string | null;
        detail: string | null;
      }>();
    await cliAudit(c, "audit_list").run();
    return c.json({
      events: results.map((e) => ({
        id: e.id,
        createdAt: e.created_at,
        source: e.source,
        actorUserId: e.actor_user_id,
        action: e.action,
        target: e.target,
        ip: e.ip,
        detail: e.detail ? JSON.parse(e.detail) : null,
      })),
    });
  });

  // Local CLI actions (sessions and bans in the webmail's SQLite) still belong in the D1 audit log.
  app.post("/v1/admin/audit", async (c) => {
    const body = await jsonBody(c, schema.cliAuditBody);
    if (!body.success) return error(c, 400, "bad_request");
    const { action, target, detail } = body.data;
    await cliAudit(c, action, {
      ...(target ? { target } : {}),
      ...(detail ? { detail } : {}),
    }).run();
    return c.body(null, 204);
  });

  app.notFound((c) => error(c, 404, "not_found"));
  app.onError((err, c) => {
    log({ event: "api_error", error: errorName(err) });
    return error(c, 500, "internal_error");
  });

  return app;
}

function error(
  c: Context<Api>,
  status: 400 | 401 | 404 | 409 | 429 | 500,
  code: string,
) {
  return c.json({ error: code }, status);
}

function jsonBody<R>(
  c: Context<Api>,
  schema: { safeParse(data: unknown): R },
): Promise<R> {
  return c.req
    .json()
    .catch(() => undefined)
    .then((data) => schema.safeParse(data));
}

/** Never the hash, the TOTP secret or the setup token hash: only whether they exist. */
const ADMIN_USER_COLUMNS = `id, username, display_name, role, active,
  password_hash IS NOT NULL AS has_password, totp_secret_enc IS NOT NULL AS has_totp,
  CASE WHEN setup_expires_at > ${NOW} THEN setup_expires_at END AS setup_expires_at,
  created_at, updated_at`;

type AdminUserRow = {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  active: number;
  has_password: number;
  has_totp: number;
  setup_expires_at: string | null;
  created_at: string;
  updated_at: string | null;
};

function adminUser(u: AdminUserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    active: u.active === 1,
    hasPassword: u.has_password === 1,
    hasTotp: u.has_totp === 1,
    setupExpiresAt: u.setup_expires_at,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
  };
}

/**
 * An audit event from the CLI. With `userId`, the event targets that user and is written only
 * if the user exists, so in a batch after an UPDATE it records only a change that happened.
 */
function cliAudit(
  c: Context<Api>,
  action: string,
  options: {
    userId?: string;
    target?: string;
    detail?: Record<string, unknown>;
  } = {},
): D1PreparedStatement {
  const header = schema.ip.safeParse(c.req.header("CF-Connecting-IP"));
  const ip = header.success ? header.data : null;
  const detail = options.detail ? JSON.stringify(options.detail) : null;
  if (options.userId)
    return c.env.DB.prepare(
      `INSERT INTO audit_log (source, action, target, ip, detail)
       SELECT 'cli', ?1, id, ?2, ?3 FROM users WHERE id = ?4`,
    ).bind(action, ip, detail, options.userId);
  return c.env.DB.prepare(
    `INSERT INTO audit_log (source, action, target, ip, detail) VALUES ('cli', ?1, ?2, ?3, ?4)`,
  ).bind(action, options.target ?? null, ip, detail);
}

async function sameSecret(given: string, expected: string): Promise<boolean> {
  // Hashing first gives equal lengths, so the comparison time says nothing about the secret.
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(given)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The message, only if the user may read its mailbox. Access is decided by the message's own mailbox. */
async function readableMessage(
  c: Context<Api>,
  id: string,
): Promise<MessageRow | null> {
  const parsed = schema.messageId.safeParse(id);
  if (!parsed.success) return null;
  return c.env.DB.prepare(
    `SELECT m.* FROM messages m
     JOIN user_mailboxes p ON p.mailbox_id = m.mailbox_id AND p.user_id = ?2 AND p.can_read = 1
     WHERE m.id = ?1`,
  )
    .bind(parsed.data, c.get("userId"))
    .first<MessageRow>();
}

function summary(m: MessageRow) {
  return {
    id: m.id,
    mailboxId: m.mailbox_id,
    folder: m.folder,
    from: m.from_address
      ? { address: m.from_address, name: m.from_name }
      : null,
    subject: m.subject,
    snippet: m.snippet,
    date: m.header_date,
    receivedAt: m.received_at,
    size: m.size,
    hasAttachments: m.has_attachments === 1,
    isRead: m.is_read === 1,
    auth: { spf: m.spf, dkim: m.dkim, dmarc: m.dmarc },
    parseStatus: m.parse_status,
  };
}

function encodeCursor(receivedAt: string, id: string): string {
  return btoa(`${receivedAt}|${id}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** null for a cursor that was not made by encodeCursor. */
function decodeCursor(
  cursor: string,
): { receivedAt: string; id: string } | null {
  try {
    const [receivedAt = "", id = "", ...rest] = atob(
      cursor.replace(/-/g, "+").replace(/_/g, "/"),
    ).split("|");
    if (rest.length > 0 || !RECEIVED_AT.test(receivedAt)) return null;
    if (!schema.messageId.safeParse(id).success) return null;
    return { receivedAt, id };
  } catch {
    return null;
  }
}

/** Always a download: the sender's content type never reaches the browser. */
async function download(
  env: Env,
  key: string,
  filename: string | null,
  fallback: string,
): Promise<Response> {
  const object = await env.MAIL.get(key);
  if (!object) throw new Error("Stored object missing from R2");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": contentDisposition(filename, fallback),
      "Content-Length": String(object.size),
      "Cache-Control": "private, no-store",
    },
  });
}

/** RFC 6266: an ASCII fallback plus the UTF-8 name, both free of controls, paths and quotes. */
export function contentDisposition(
  filename: string | null,
  fallback: string,
): string {
  const cleaned = (filename ?? "")
    .normalize("NFC")
    // Lone surrogates, control and bidirectional characters (which can disguise an extension).
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point.
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    )
    .replace(/[/\\]/g, "_")
    .replace(/^[\s.]+/, "")
    .trim();
  const name = Array.from(cleaned).slice(0, 200).join("") || fallback;
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
