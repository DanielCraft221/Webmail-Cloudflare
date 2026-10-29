import { z } from "zod";

/** Request schemas of the mail-core internal API (docs/api.md). */

export const FOLDERS = ["inbox", "archive", "spam", "trash", "sent"] as const;
export const folder = z.enum(FOLDERS);
/** `sent` is set only by sending (Etapa 8), never by moving a message. */
export const movableFolder = z.enum(["inbox", "archive", "spam", "trash"]);

export const MAX_PAGE_SIZE = 100;
export const MAX_SEARCH_LENGTH = 100;

export const messageId = z.uuid();
export const mailboxId = z.coerce
  .number()
  .int()
  .positive()
  .max(2 ** 53 - 1);

export const listMessagesQuery = z.object({
  folder: folder.default("inbox"),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
});

export const patchMessageBody = z
  .strictObject({
    isRead: z.boolean().optional(),
    folder: movableFolder.optional(),
  })
  .refine((body) => body.isRead !== undefined || body.folder !== undefined, {
    message: "Nothing to change",
  });

/** In the body, not the query string: URLs end up in platform logs (docs/decisoes.md). */
export const searchBody = z.strictObject({
  q: z.string().trim().min(1).max(MAX_SEARCH_LENGTH),
  mailbox: z
    .number()
    .int()
    .positive()
    .max(2 ** 53 - 1)
    .optional(),
});
