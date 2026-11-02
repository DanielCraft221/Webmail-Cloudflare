import { api } from "@webmail/shared";
import type { z } from "zod";

/** Where and how to reach the mail-core API (docs/api.md). Tokens never go into a URL or a log. */
export interface ApiConfig {
  apiUrl: string;
  bearer: string;
  accessClientId: string;
  accessClientSecret: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`mail-core API answered ${status}`);
    this.status = status;
  }
}

/** http only for a loopback host (the fake Worker in tests); anything else must be https. */
export function checkApiUrl(value: string | undefined): string {
  const url = new URL(value ?? "");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("MAIL_API_URL must be https");
  return url.origin;
}

function headersFor(cfg: ApiConfig, user?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "CF-Access-Client-Id": cfg.accessClientId,
    "CF-Access-Client-Secret": cfg.accessClientSecret,
    Authorization: `Bearer ${cfg.bearer}`,
  };
  if (user) headers["X-Webmail-User"] = user;
  return headers;
}

export async function call<T extends z.ZodType>(
  cfg: ApiConfig,
  method: string,
  path: string,
  options: {
    body?: unknown;
    user?: string;
    schema?: T;
    okStatus?: number;
  } = {},
): Promise<{ status: number; data: z.infer<T> | null }> {
  const headers = headersFor(cfg, options.user);
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? null : JSON.stringify(options.body),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404 || res.status === 401 || res.status === 409) {
    await res.body?.cancel();
    return { status: res.status, data: null };
  }
  if (res.status !== (options.okStatus ?? 200)) {
    await res.body?.cancel();
    throw new ApiError(res.status);
  }
  if (!options.schema) {
    await res.body?.cancel();
    return { status: res.status, data: null };
  }
  // Every answer is checked against the shared schema; nothing raw goes back to the browser.
  return { status: res.status, data: options.schema.parse(await res.json()) };
}

/**
 * A download (attachment or .eml) as the Worker sends it, or null on 404/401. The caller builds
 * its own response from the body and never passes these headers on. 10 minutes for the whole
 * transfer: an 18 MB attachment does not fit in the 10 s of the JSON calls.
 */
export async function download(
  cfg: ApiConfig,
  path: string,
  user: string,
): Promise<Response | null> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    headers: headersFor(cfg, user),
    redirect: "error",
    signal: AbortSignal.timeout(600_000),
  });
  if (res.status === 404 || res.status === 401) {
    await res.body?.cancel();
    return null;
  }
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    throw new ApiError(res.status);
  }
  return res;
}

/** Calls the webmail makes with the internal token. */
export function webmailApi(cfg: ApiConfig) {
  return {
    async authLookup(username: string) {
      return (
        await call(cfg, "POST", "/v1/auth/lookup", {
          body: { username },
          schema: api.authLookupResponse,
        })
      ).data;
    },
    async setupLookup(tokenHash: string) {
      return (
        await call(cfg, "POST", "/v1/auth/setup/lookup", {
          body: { tokenHash },
          schema: api.setupUserResponse,
        })
      ).data;
    },
    async setupComplete(body: z.infer<typeof api.setupCompleteBody>) {
      return (
        await call(cfg, "POST", "/v1/auth/setup/complete", {
          body,
          schema: api.setupUserResponse,
        })
      ).data;
    },
    /** null means 401: the user is disabled or gone. */
    async me(userId: string) {
      return (
        await call(cfg, "GET", "/v1/me", {
          user: userId,
          schema: api.meResponse,
        })
      ).data;
    },
    /** null: not found or not readable by this user (the Worker decides; the two look the same). */
    async message(userId: string, id: string) {
      return (
        await call(cfg, "GET", `/v1/messages/${encodeURIComponent(id)}`, {
          user: userId,
          schema: api.messageDetail,
        })
      ).data;
    },
    attachment(userId: string, id: string, attId: string) {
      return download(
        cfg,
        `/v1/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attId)}`,
        userId,
      );
    },
    raw(userId: string, id: string) {
      return download(
        cfg,
        `/v1/messages/${encodeURIComponent(id)}/raw`,
        userId,
      );
    },
    async audit(body: z.infer<typeof api.webmailAuditBody>) {
      await call(cfg, "POST", "/v1/audit", {
        body: api.webmailAuditBody.parse(body),
        okStatus: 204,
      });
    },
  };
}

export type WebmailApi = ReturnType<typeof webmailApi>;
