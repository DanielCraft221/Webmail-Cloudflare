import { error } from "@sveltejs/kit";
import { ctx } from "#lib/server/context.ts";
import { checkId, NOT_FOUND, requireUser } from "#lib/server/read.ts";
import type { PageServerLoad } from "./$types";

/**
 * Only reads: opening a message never marks it as read here (SvelteKit preloads links on hover).
 * The body never goes into the page data; the iframe loads it from /corpo, sanitized.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
  const user = requireUser(locals);
  const message = await ctx().api.message(user.id, checkId(params.id));
  if (!message) error(404, NOT_FOUND);
  return {
    id: message.id,
    subject: message.subject,
    from: message.from,
    to: message.to,
    cc: message.cc,
    date: message.date,
    receivedAt: message.receivedAt,
    attachments: message.attachments.map(({ id, filename, size }) => ({
      id,
      filename,
      size,
    })),
  };
};
