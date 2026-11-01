import { redirect } from "@sveltejs/kit";
import { audit } from "#lib/server/audit.ts";
import { ctx } from "#lib/server/context.ts";
import { SESSION_COOKIE } from "#lib/server/cookie.ts";
import { deleteSession } from "#lib/server/sessions.ts";
import type { RequestHandler } from "./$types";

/** POST only (GET answers 405), so a link or an image cannot log anyone out. */
export const POST: RequestHandler = ({ locals, cookies }) => {
  const { db, api } = ctx();
  if (locals.sessionHash && locals.user) {
    deleteSession(db, locals.sessionHash);
    audit(api, {
      action: "logout",
      actorUserId: locals.user.id,
      target: locals.user.username,
      ip: locals.ip,
    });
  }
  cookies.delete(SESSION_COOKIE, { path: "/" });
  redirect(303, "/login");
};
