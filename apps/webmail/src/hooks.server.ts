import { error } from "@sveltejs/kit";
import type {
  Handle,
  HandleServerError,
  ServerInit,
} from "@sveltejs/kit/hooks";
import { ctx, initContext } from "#lib/server/context.ts";
import { SESSION_COOKIE } from "#lib/server/cookie.ts";
import { parseIp } from "#lib/server/ip.ts";
import { log } from "#lib/server/log.ts";
import {
  deleteSessionsBefore,
  deleteUserSessions,
  getSession,
  markChecked,
  RECHECK_AFTER,
  type SessionUser,
} from "#lib/server/sessions.ts";

export const init: ServerInit = async () => {
  await initContext();
};

const SECURITY_HEADERS: Record<string, string> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=(), interest-cohort=()",
};
/** Responses that are not pages (redirects, errors from endpoints) get a closed CSP too. */
const FALLBACK_CSP =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function secure(
  response: Response,
  production: boolean,
  pathname: string,
): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    response.headers.set(name, value);
  if (!response.headers.has("Content-Security-Policy"))
    response.headers.set("Content-Security-Policy", FALLBACK_CSP);
  if (!pathname.startsWith("/_app/immutable/"))
    response.headers.set("Cache-Control", "no-store");
  if (production)
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  return response;
}

export const handle: Handle = async ({ event, resolve }) => {
  const { config, db, api } = ctx();
  const path = event.url.pathname;

  // Production: only CF-Connecting-IP, never the socket (that would be cloudflared, and one ban would block everyone).
  const ip = config.production
    ? parseIp(event.request.headers.get("cf-connecting-ip"))
    : parseIp(event.getClientAddress());
  if (!ip)
    return secure(
      new Response("Bad Request", { status: 400 }),
      config.production,
      path,
    );
  event.locals.ip = ip;
  event.locals.user = null;
  event.locals.sessionHash = null;

  const token = event.cookies.get(SESSION_COOKIE);
  if (token) {
    const now = Date.now();
    const session = getSession(db, token, now);
    if (!session) event.cookies.delete(SESSION_COOKIE, { path: "/" });
    else {
      let user: SessionUser | null = session.user;
      // Logout always works, even when the API is down.
      if (path !== "/logout" && now - session.checkedAt >= RECHECK_AFTER) {
        let me: Awaited<ReturnType<typeof api.me>>;
        try {
          me = await api.me(user.id);
        } catch {
          log("error", "me_check_failed");
          error(503, "Serviço indisponível. Tente de novo em instantes.");
        }
        // Changed in D1 after this session started (reset, setup, role): every older session goes.
        const changedAt = me?.updatedAt ? Date.parse(me.updatedAt) : null;
        if (me && changedAt !== null && session.createdAt < changedAt) {
          deleteSessionsBefore(db, me.id, changedAt);
          event.cookies.delete(SESSION_COOKIE, { path: "/" });
          user = null;
        } else if (me) {
          user = {
            id: me.id,
            username: me.username,
            displayName: me.displayName,
            role: me.role,
          };
          markChecked(db, session.tokenHash, user, now);
        } else {
          // 401: disabled or deleted user. Every session of theirs goes now.
          deleteUserSessions(db, user.id);
          event.cookies.delete(SESSION_COOKIE, { path: "/" });
          user = null;
        }
      }
      event.locals.user = user;
      event.locals.sessionHash = user ? session.tokenHash : null;
    }
  }

  return secure(await resolve(event), config.production, path);
};

/** Unexpected errors: only their kind goes to the log, never the message (it could carry input). */
export const handleError: HandleServerError = ({ kind, error, event }) => {
  if (kind !== "unknown") return;
  log("error", "unexpected_error", {
    route: event.route.id,
    kind: error instanceof Error ? error.name : typeof error,
  });
  return { message: "Erro interno." };
};
