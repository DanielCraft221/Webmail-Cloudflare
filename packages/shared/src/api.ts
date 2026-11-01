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

// --- Authentication and administration (Etapa 5) ---

export const ROLES = ["admin", "user"] as const;
export const role = z.enum(ROLES);

/** Lowercase, starts with a letter or digit: safe in the CLI, logs and URLs. */
export const username = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "Invalid username");
/** SHA-256 hex of a setup link token. The token itself never reaches the API. */
export const tokenHash = z.string().regex(/^[0-9a-f]{64}$/);
/** PHC string from argon2id (docs/webmail-auth.md). */
export const passwordHash = z
  .string()
  .max(256)
  .regex(
    /^\$argon2id\$v=19\$m=\d{1,10},t=\d{1,3},p=\d{1,3}\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/,
  );
/** AES-256-GCM output from the webmail: "v1.<iv>.<ciphertext+tag>", base64url. Opaque to the API. */
export const totpSecretEnc = z
  .string()
  .max(512)
  .regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
/** No control or format characters: these strings end up printed in the admin's terminal (CLI). */
const plainText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, "Control characters are not allowed");
export const displayName = plainText(100).trim().min(1);
export const ip = z.union([z.ipv4(), z.ipv6()]);

export const authLookupBody = z.strictObject({ username });
export const setupLookupBody = z.strictObject({ tokenHash });
export const setupCompleteBody = z.strictObject({
  tokenHash,
  passwordHash,
  totpSecretEnc,
});

/** Events the webmail records with the internal token (source "webmail"). */
export const webmailAuditAction = z.enum([
  "login_success",
  "login_failure",
  "logout",
  "ip_ban",
  "username_lock",
  "setup_complete",
]);
/** Local actions of the CLI (sessions and bans live in the webmail's SQLite), recorded with the admin token. */
export const cliAuditAction = z.enum([
  "session_revoke",
  "ip_ban",
  "ip_unban",
  "username_unlock",
]);
/** Short, flat details: never a password, code, token or cookie. */
const auditDetail = z
  .record(
    z.string().max(32),
    z.union([plainText(100), z.number(), z.boolean(), z.null()]),
  )
  .refine(
    (d) => Object.keys(d).length <= 10 && JSON.stringify(d).length <= 500,
    {
      message: "Detail too large",
    },
  );
const auditTarget = plainText(100).min(1);

export const webmailAuditBody = z.strictObject({
  action: webmailAuditAction,
  actorUserId: messageId.nullable().optional(),
  target: auditTarget.optional(),
  ip: ip.optional(),
  detail: auditDetail.optional(),
});
export const cliAuditBody = z.strictObject({
  action: cliAuditAction,
  target: auditTarget.optional(),
  detail: auditDetail.optional(),
});

export const createUserBody = z.strictObject({
  username,
  role: role.default("user"),
  displayName: displayName.optional(),
  setupTokenHash: tokenHash,
});
export const resetUserBody = z.strictObject({ setupTokenHash: tokenHash });
export const patchUserBody = z
  .strictObject({
    active: z.boolean().optional(),
    role: role.optional(),
    displayName: displayName.nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "Nothing to change",
  });
export const MAX_AUDIT_LIMIT = 500;
export const auditListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_AUDIT_LIMIT).default(50),
});

/** Responses the webmail parses (its fake Worker in tests returns the same shapes). */
export const authLookupResponse = z.object({
  id: messageId,
  active: z.boolean(),
  role,
  passwordHash: passwordHash.nullable(),
  totpSecretEnc: totpSecretEnc.nullable(),
});
export const setupUserResponse = z.object({ id: messageId, username });
export const meResponse = z.object({
  id: messageId,
  username,
  displayName: z.string().nullable(),
  role,
});
