import { error } from "@sveltejs/kit";
import { ctx } from "#lib/server/context.ts";
import { renderBody } from "#lib/server/message-body.ts";
import { checkId, NOT_FOUND, requireUser } from "#lib/server/read.ts";
import type { RequestHandler } from "./$types";

/**
 * The sanitized body, alone, for the sandboxed iframe. Its CSP, X-Frame-Options and
 * Referrer-Policy are set in hooks.server.ts (BODY_ROUTE), the only route that can be framed.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals);
  const { api, sanitizer } = ctx();
  const message = await api.message(user.id, checkId(params.id));
  if (!message) error(404, NOT_FOUND);
  const result = await renderBody(message.body, sanitizer);
  if (result.status === 503)
    error(
      503,
      "Muitas mensagens sendo abertas agora. Tente de novo em instantes.",
    );
  return new Response(result.html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};
