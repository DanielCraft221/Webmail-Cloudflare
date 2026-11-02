import { error } from "@sveltejs/kit";
import { contentDisposition } from "@webmail/shared";
import { ctx } from "#lib/server/context.ts";
import {
  checkId,
  downloadResponse,
  NOT_FOUND,
  requireUser,
} from "#lib/server/read.ts";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals);
  const id = checkId(params.id);
  const res = await ctx().api.raw(user.id, id);
  if (!res) error(404, NOT_FOUND);
  return downloadResponse(res, contentDisposition(`${id}.eml`, "mensagem"));
};
