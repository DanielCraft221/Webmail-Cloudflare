import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jose";
import { createApi } from "../src/api";
import { mailboxId } from "./helpers";

/** Seeded admin (seed/0002_danielcraft221.sql): reads the three survivus.com.br mailboxes. */
export const DANIEL = "b2a98933-aa45-4af9-b0f3-dd58c4283e7b";
/** Reads only suporte@. */
export const OTHER = "00000000-0000-4000-8000-000000000001";
export const INACTIVE = "00000000-0000-4000-8000-000000000002";

export const rsa = await generateKeyPair("RS256", { extractable: true });
const ec = await generateKeyPair("ES256", { extractable: true });
export const rsaJwk = {
  ...(await exportJWK(rsa.publicKey)),
  kid: "test-rsa",
  alg: "RS256",
};
// An EC key in the set: ES256 tokens must still be refused, by algorithm.
const localKeys = createLocalJWKSet({
  keys: [
    rsaJwk,
    { ...(await exportJWK(ec.publicKey)), kid: "test-ec", alg: "ES256" },
  ],
});
export const ecPrivateKey = ec.privateKey;

/** Test-only key injection: production code never receives these keys. */
export const api = createApi(() => localKeys);

const allowAll = { limit: async () => ({ success: true }) } as RateLimit;
export const apiEnv: Env = { ...env, API_RATE_LIMIT: allowAll };

/** A valid Access token for the test configuration; `claims` overrides or removes (undefined) fields. */
export async function accessJwt(
  claims: Record<string, unknown> = {},
  options: { alg?: string; kid?: string; key?: CryptoKey | Uint8Array } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = Object.fromEntries(
    Object.entries({
      type: "app",
      iss: env.ACCESS_TEAM_DOMAIN,
      aud: [env.ACCESS_AUD],
      common_name: env.ACCESS_CLIENT_ID,
      sub: "",
      iat: now,
      nbf: now,
      exp: now + 300,
      ...claims,
    }).filter(([, value]) => value !== undefined),
  ) as JWTPayload;
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: options.alg ?? "RS256",
      kid: options.kid ?? "test-rsa",
    })
    .sign(options.key ?? rsa.privateKey);
}

export async function validHeaders(
  user: string = DANIEL,
): Promise<Record<string, string>> {
  return {
    "Cf-Access-Jwt-Assertion": await accessJwt(),
    Authorization: `Bearer ${env.INTERNAL_API_TOKEN}`,
    "X-Webmail-User": user,
  };
}

/** Calls the API with valid credentials; `headers` overrides them, null removes one. */
export async function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    user?: string;
    headers?: Record<string, string | null>;
    env?: Env;
  } = {},
): Promise<Response> {
  const headers = new Headers(await validHeaders(options.user));
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.body !== undefined)
    init.body =
      typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  return api.fetch(
    new Request(`https://mail-api.test${path}`, init),
    options.env ?? apiEnv,
    createExecutionContext(),
  );
}

/** Fake values in the stored format: the user routes only open for users who finished setup. */
export const FAKE_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGg";
export const FAKE_TOTP_ENC = "v1.aXZpdml2aXZpdml2.Y2lwaGVydGV4dGNpcGhlcnRleHQ";

export async function addTestUsers() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, username, role) VALUES (?1, 'outro', 'user'), (?2, 'inativo', 'user')",
    ).bind(OTHER, INACTIVE),
    env.DB.prepare(
      "UPDATE users SET password_hash = ?4, totp_secret_enc = ?5 WHERE id IN (?1, ?2, ?3)",
    ).bind(DANIEL, OTHER, INACTIVE, FAKE_PASSWORD_HASH, FAKE_TOTP_ENC),
    env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?1").bind(INACTIVE),
    env.DB.prepare(
      "INSERT OR IGNORE INTO user_mailboxes (user_id, mailbox_id, can_read) SELECT ?1, id, 1 FROM mailboxes WHERE address = 'suporte@survivus.com.br'",
    ).bind(OTHER),
    env.DB.prepare(
      "INSERT OR IGNORE INTO user_mailboxes (user_id, mailbox_id, can_read) SELECT ?1, id, 1 FROM mailboxes",
    ).bind(INACTIVE),
  ]);
}

let counter = 0;

/** Inserts a message row with its .eml and body in R2. Returns its id. */
export async function addMessage(
  options: {
    mailbox?: string;
    folder?: string;
    subject?: string;
    from?: string;
    fromName?: string;
    receivedAt?: string;
    isRead?: boolean;
    id?: string;
  } = {},
): Promise<string> {
  counter += 1;
  const id = options.id ?? crypto.randomUUID();
  const raw = `Subject: ${options.subject ?? "Teste"}\r\n\r\nCorpo ${id}\r\n`;
  await env.MAIL.put(`raw/2026/10/${id}.eml`, raw);
  await env.MAIL.put(
    `body/${id}.json`,
    JSON.stringify({ text: `Corpo ${id}`, html: `<p>Corpo ${id}</p>` }),
  );
  await env.DB.prepare(
    `INSERT INTO messages (id, mailbox_id, folder, dedupe_key, from_address, from_name, subject,
       snippet, received_at, size, is_read, raw_key, body_key, parse_status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'snippet', ?8, ?9, ?10, ?11, ?12, 'ok')`,
  )
    .bind(
      id,
      await mailboxId(options.mailbox ?? "contato@survivus.com.br"),
      options.folder ?? "inbox",
      `sha256:${id}`,
      options.from ?? "ana.teste@example.net",
      options.fromName ?? "Ana Teste",
      options.subject ?? "Teste",
      options.receivedAt ??
        new Date(Date.UTC(2026, 9, 1) + counter * 1000).toISOString(),
      raw.length,
      options.isRead ? 1 : 0,
      `raw/2026/10/${id}.eml`,
      `body/${id}.json`,
    )
    .run();
  return id;
}

/** Inserts an attachment row and its R2 object. Returns its id. */
export async function addAttachment(
  messageId: string,
  options: { filename?: string | null; contentType?: string; content?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  const content = options.content ?? "conteudo";
  const key = `att/${messageId}/${id}`;
  await env.MAIL.put(key, content, {
    httpMetadata: { contentType: options.contentType ?? "text/plain" },
  });
  await env.DB.prepare(
    `INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      id,
      messageId,
      options.filename === undefined ? "arquivo.txt" : options.filename,
      options.contentType ?? "text/plain",
      new TextEncoder().encode(content).byteLength,
      key,
    )
    .run();
  return id;
}
