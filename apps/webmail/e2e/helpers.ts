import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import {
  type APIRequestContext,
  request as playwrightRequest,
} from "@playwright/test";
import { base32Decode, hotp, stepAt } from "../src/lib/server/totp.ts";
import { FAKE } from "../test/fake-tokens.ts";

export const BASE = "http://localhost:4173";
const API = "http://127.0.0.1:8790";
export const GENERIC = "Usuário, senha ou código inválidos.";
export const BANNED = "Muitas tentativas. Tente de novo mais tarde.";

// Random start: Playwright restarts the worker after a failure, and the app's SQLite keeps its bans.
let counter = Math.floor(Math.random() * 60_000);
/** A fresh IP from 198.18.0.0/15 (benchmark range) per call, so tests never share a ban. */
export function freshIp(): string {
  counter = (counter + 1) % 131_000;
  return `198.${18 + Math.floor(counter / 65_536)}.${Math.floor(counter / 256) % 256}.${(counter % 254) + 1}`;
}

/** Everything secret a test types, so e2e/logs.spec.ts can check none of it reached the log. */
export function remember(...values: string[]) {
  mkdirSync("test-results", { recursive: true });
  for (const v of values) appendFileSync("test-results/secrets.txt", `${v}\n`);
}

const adminHeaders = {
  "CF-Access-Client-Id": FAKE.accessId,
  "CF-Access-Client-Secret": FAKE.accessSecret,
  Authorization: `Bearer ${FAKE.adminToken}`,
};

/** What `pnpm admin user:create` does, against the fake Worker: returns the link token. */
export async function createUser(request: APIRequestContext, username: string) {
  const token = randomBytes(32).toString("base64url");
  const setupTokenHash = createHash("sha256").update(token).digest("hex");
  const res = await request.post(`${API}/v1/admin/users`, {
    headers: adminHeaders,
    data: { username, setupTokenHash },
  });
  if (res.status() !== 201) throw new Error(`createUser ${res.status()}`);
  remember(token);
  return { token, id: (await res.json()).id as string };
}

export async function setActive(
  request: APIRequestContext,
  id: string,
  active: boolean,
) {
  const res = await request.patch(`${API}/v1/admin/users/${id}`, {
    headers: adminHeaders,
    data: { active },
  });
  if (res.status() !== 200) throw new Error(`setActive ${res.status()}`);
}

export async function auditEvents(request: APIRequestContext) {
  const res = await request.get(`${API}/v1/admin/audit?limit=500`, {
    headers: adminHeaders,
  });
  return (await res.json()).events as {
    action: string;
    target: string | null;
    ip: string | null;
    detail: unknown;
  }[];
}

export function totp(secret: string, offset = 0): string {
  return hotp(base32Decode(secret), stepAt(Date.now()) + offset);
}

export function secretFrom(html: string): string {
  const match = /data-testid="totp-secret"[^>]*>([A-Z2-7 ]+)</.exec(html);
  if (!match?.[1]) throw new Error("no secret on the page");
  return match[1].replace(/ /g, "");
}

export interface Reply {
  status(): number;
  headers(): Record<string, string>;
  text(): Promise<string>;
}

/** One request from a fresh context: no cookie jar, so a cookie is sent only when a test passes one. */
async function send(
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  form?: Record<string, string>,
): Promise<Reply> {
  const context = await playwrightRequest.newContext({ baseURL: BASE });
  try {
    const res = await context.fetch(path, {
      method,
      headers: { Accept: "text/html", ...headers },
      ...(form ? { form } : {}),
      maxRedirects: 0,
    });
    const body = await res.text();
    const status = res.status();
    const all = res.headers();
    return { status: () => status, headers: () => all, text: async () => body };
  } finally {
    await context.dispose();
  }
}

/** A form POST as the browser would send it: same Origin, real IP in CF-Connecting-IP. */
export function post(
  _r: APIRequestContext,
  path: string,
  form: Record<string, string>,
  ip: string,
  origin = BASE,
  cookie?: string,
) {
  return send(
    "POST",
    path,
    {
      Origin: origin,
      "CF-Connecting-IP": ip,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    form,
  );
}

export function get(
  _r: APIRequestContext,
  path: string,
  ip: string,
  cookie?: string,
) {
  return send("GET", path, {
    "CF-Connecting-IP": ip,
    ...(cookie ? { Cookie: cookie } : {}),
  });
}

/** Creates a user and completes the setup link. The code used here cannot log in again. */
export async function readyUser(
  request: APIRequestContext,
  username: string,
  password = `pw-${randomBytes(9).toString("hex")}`,
) {
  const ip = freshIp();
  const { token, id } = await createUser(request, username);
  const page = await get(request, `/setup/${token}`, ip);
  const secret = secretFrom(await page.text());
  const code = totp(secret);
  remember(password, secret, code);
  const res = await post(
    request,
    `/setup/${token}`,
    { password, confirm: password, code },
    ip,
  );
  if (res.status() !== 303)
    throw new Error(`setup ${res.status()}: ${await res.text()}`);
  return { id, username, password, secret, token };
}

export function sessionCookie(setCookie: string | undefined): string {
  const match = /__Host-webmail_session=([^;]+)/.exec(setCookie ?? "");
  if (!match?.[1]) throw new Error("no session cookie");
  remember(match[1]);
  return `__Host-webmail_session=${match[1]}`;
}
