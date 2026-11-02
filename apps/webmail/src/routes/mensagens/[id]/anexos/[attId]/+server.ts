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
  const { api } = ctx();
  const id = checkId(params.id);
  const attId = checkId(params.attId);
  // The name comes from the message the Worker let this user read, cleaned like the Worker does.
  const attachment = (await api.message(user.id, id))?.attachments.find(
    (a) => a.id === attId,
  );
  const res = attachment ? await api.attachment(user.id, id, attId) : null;
  if (!attachment || !res) error(404, NOT_FOUND);
  return downloadResponse(
    res,
    contentDisposition(attachment.filename, "anexo"),
  );
};
