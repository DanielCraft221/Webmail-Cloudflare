import PostalMime, { type Address, type Email } from "postal-mime";
import {
  parseAuthenticationResults,
  TRUSTED_AUTHSERV_IDS,
} from "./auth-results";
import { stableUuid } from "./hash";
import { errorName, log } from "./log";

/** Queue message sent by the email handler. It never carries the subject or body. */
export type IngestJob = {
  id: string;
  rawKey: string;
  mailboxId: number;
  dedupeKey: string;
  receivedAt: string;
  size: number;
};

export type IngestOutcome = "stored" | "already_stored" | "duplicate";

// Tighter than postal-mime's defaults: real mail never nests this deep, and it bounds CPU and memory.
const PARSE_LIMITS = { maxNestingDepth: 50, maxPartCount: 1000 };
const SNIPPET_LENGTH = 200;
/** RFC 5322 line length limit, also used to cap stored header values. */
const MAX_HEADER_LENGTH = 998;
const MAX_RETRY_DELAY_SECONDS = 3600;

export async function handleQueue(
  batch: MessageBatch<IngestJob>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await ingest(message.body, env);
      log({
        event: "ingested",
        messageId: message.body.id,
        status: outcome,
        attempt: message.attempts,
      });
      message.ack();
    } catch (error) {
      log({
        event: "ingest_failed",
        messageId: message.body.id,
        attempt: message.attempts,
        error: errorName(error),
      });
      // After max_retries (wrangler.jsonc) the message goes to the dead letter queue. The .eml stays in R2.
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

/** 30 s, doubling per attempt, capped at 1 h. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), MAX_RETRY_DELAY_SECONDS);
}

/** Idempotent: a retry rewrites the same R2 keys and the D1 batch is all or nothing. */
export async function ingest(
  job: IngestJob,
  env: Env,
  trustedAuthservIds: readonly string[] = TRUSTED_AUTHSERV_IDS,
): Promise<IngestOutcome> {
  const object = await env.MAIL.get(job.rawKey);
  if (!object) throw new Error("Raw message missing from R2");
  const raw = await object.arrayBuffer();

  let email: Email | null = null;
  try {
    email = await PostalMime.parse(raw, PARSE_LIMITS);
  } catch (error) {
    log({ event: "parse_failed", messageId: job.id, error: errorName(error) });
  }

  const writtenKeys: string[] = [];
  const statements: D1PreparedStatement[] = [];
  let bodyKey: string | null = null;

  if (email) {
    bodyKey = `body/${job.id}.json`;
    await env.MAIL.put(
      bodyKey,
      JSON.stringify({ text: email.text ?? null, html: email.html ?? null }),
      {
        httpMetadata: { contentType: "application/json" },
      },
    );
    writtenKeys.push(bodyKey);
  }

  const auth = email
    ? parseAuthenticationResults(email.headers, trustedAuthservIds)
    : parseAuthenticationResults([]);
  const from = email?.from && !email.from.group ? email.from : null;

  statements.push(
    env.DB.prepare(
      `INSERT INTO messages (id, mailbox_id, folder, message_id, dedupe_key, in_reply_to, references_ids,
         from_address, from_name, to_json, cc_json, subject, snippet, header_date, received_at,
         size, has_attachments, spf, dkim, dmarc, raw_key, body_key, parse_status)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
    ).bind(
      job.id,
      job.mailboxId,
      auth.dmarc === "fail" ? "spam" : "inbox",
      (email
        ? (email.messageId ?? null)
        : readRawHeader(raw, "message-id")
      )?.slice(0, MAX_HEADER_LENGTH) ?? null,
      job.dedupeKey,
      email?.inReplyTo ?? null,
      email?.references ?? null,
      from?.address ?? null,
      from?.name || null,
      JSON.stringify(flattenAddresses(email?.to)),
      JSON.stringify(flattenAddresses(email?.cc)),
      email ? (email.subject ?? null) : readRawHeader(raw, "subject"),
      email ? snippet(email) : null,
      email?.date ?? null,
      job.receivedAt,
      job.size,
      email && email.attachments.length > 0 ? 1 : 0,
      auth.spf,
      auth.dkim,
      auth.dmarc,
      job.rawKey,
      bodyKey,
      email ? "ok" : "failed",
    ),
  );

  for (const [index, attachment] of (email?.attachments ?? []).entries()) {
    const attachmentId = await stableUuid(`${job.id}:${index}`);
    // Never the original filename in the key: it is attacker-controlled.
    const key = `att/${job.id}/${attachmentId}`;
    const content =
      typeof attachment.content === "string"
        ? new TextEncoder().encode(attachment.content)
        : attachment.content;
    await env.MAIL.put(key, content, {
      httpMetadata: { contentType: attachment.mimeType },
    });
    writtenKeys.push(key);
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments (id, message_id, filename, content_type, size, r2_key, content_id, is_inline)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      ).bind(
        attachmentId,
        job.id,
        attachment.filename,
        attachment.mimeType,
        content.byteLength,
        key,
        attachment.contentId ?? null,
        attachment.disposition === "inline" ? 1 : 0,
      ),
    );
  }

  try {
    await env.DB.batch(statements);
    return "stored";
  } catch (error) {
    // Unique constraint? Tell a retry of a stored job apart from a concurrent duplicate delivery.
    const existing = await env.DB.prepare(
      "SELECT id FROM messages WHERE id = ?1 OR (mailbox_id = ?2 AND dedupe_key = ?3)",
    )
      .bind(job.id, job.mailboxId, job.dedupeKey)
      .first<{ id: string }>();
    if (!existing) throw error;
    if (existing.id === job.id) return "already_stored";
    // Concurrent duplicate: keep the .eml under dup/, as the email handler does, and drop the rest.
    await env.MAIL.put(job.rawKey.replace(/^raw\//, "dup/"), raw, {
      httpMetadata: { contentType: "message/rfc822" },
      ...(object.customMetadata
        ? { customMetadata: object.customMetadata }
        : {}),
    });
    await env.MAIL.delete([job.rawKey, ...writtenKeys]);
    log({
      event: "duplicate",
      messageId: job.id,
      status: "stored_as_duplicate",
      dedupeKey: job.dedupeKey,
    });
    return "duplicate";
  }
}

function flattenAddresses(
  addresses: Address[] | undefined,
): { address: string; name: string }[] {
  return (addresses ?? [])
    .flatMap((a) => (a.group ? a.group : [a]))
    .map(({ address, name }) => ({ address, name }));
}

function snippet(email: Email): string | null {
  const text = email.text ?? email.html?.replace(/<[^>]*>/g, " ") ?? "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed ? collapsed.slice(0, SNIPPET_LENGTH) : null;
}

/** Fallback when parsing fails: the first header named `name`, unfolded and not decoded. */
export function readRawHeader(raw: ArrayBuffer, name: string): string | null {
  const head = new TextDecoder().decode(raw.slice(0, 64 * 1024));
  const end = head.search(/\r?\n\r?\n/);
  const unfolded = (end === -1 ? head : head.slice(0, end)).replace(
    /\r?\n[ \t]+/g,
    " ",
  );
  const prefix = `${name.toLowerCase()}:`;
  const line = unfolded
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().startsWith(prefix));
  return line
    ? line.slice(prefix.length).trim().slice(0, MAX_HEADER_LENGTH)
    : null;
}
