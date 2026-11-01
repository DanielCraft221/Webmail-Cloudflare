import { dev } from "$app/env";

/** Chrome refuses __Host- cookies on http://localhost, so only `vite dev` drops the prefix. */
export const SESSION_COOKIE = dev
  ? "webmail_session"
  : "__Host-webmail_session";

export const SESSION_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: 12 * 3600,
} as const;
