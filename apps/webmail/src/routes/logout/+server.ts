import { redirect } from "@sveltejs/kit";
import { ctx } from "#lib/server/context.ts";
import { SESSION_COOKIE } from "#lib/server/cookie.ts";
import { log } from "#lib/server/log.ts";
import { deleteSession } from "#lib/server/sessions.ts";
import type { RequestHandler } from "./$types";

/** POST only (GET answers 405), so a link or an image cannot log anyone out. */
export const POST: RequestHandler = ({ locals, cookies }) => {
  const { db, api } = ctx();
  if (locals.sessionHash && locals.user) {
    deleteSession(db, locals.sessionHash);
    api
      .audit({
        action: "logout",
        actorUserId: locals.user.id,
        target: locals.user.username,
        ip: locals.ip,
      })
      .catch(() => log("error", "audit_failed", { action: "logout" }));
  }
  cookies.delete(SESSION_COOKIE, { path: "/" });
  redirect(303, "/login");
};
