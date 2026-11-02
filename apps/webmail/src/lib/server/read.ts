import { error, redirect } from "@sveltejs/kit";
import { api } from "@webmail/shared";
import type { SessionUser } from "./sessions.ts";

/** Same answer for "does not exist" and "not yours": the Worker decides access, never the URL. */
export const NOT_FOUND = "Mensagem não encontrada";

export function requireUser(locals: App.Locals): SessionUser {
  if (!locals.user) redirect(303, "/login");
  return locals.user;
}

/** A malformed id is answered like an unknown one, without calling the API. */
export function checkId(id: string): string {
  if (!api.messageId.safeParse(id).success) error(404, NOT_FOUND);
  return id;
}

/**
 * A new response with the webmail's own download headers: never the Worker's response, never
 * the type declared by the sender. The body is streamed.
 */
export function downloadResponse(res: Response, disposition: string): Response {
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": disposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
  // fetch decompresses a Content-Encoding body, so the length is kept only for an unencoded one.
  const length = res.headers.get("content-length");
  if (
    length &&
    /^\d{1,15}$/.test(length) &&
    !res.headers.has("content-encoding")
  )
    headers.set("Content-Length", length);
  return new Response(res.body, { headers });
}
