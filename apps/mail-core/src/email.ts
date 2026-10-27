import { sha256Hex } from "./hash";
import type { IngestJob } from "./ingest";
import { domainOf, errorName, type LogEntry, log } from "./log";

/** Same limit Email Routing enforces on inbound mail (docs/cloudflare-email-routing.md). */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
/** Longer Message-IDs are hashed, keeping the key small for the index and R2 metadata. */
const MAX_MESSAGE_ID_LENGTH = 200;

/**
 * Accepts or rejects the message, then stores the raw .eml and queues it for parsing.
 * Internal errors never call setReject (a permanent failure): they forward to the fallback address.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<void> {
  const recipient = message.to.trim().toLowerCase();
  const context: LogEntry = {
    event: "received",
    mailbox: recipient,
    senderDomain: domainOf(message.from),
    size: message.rawSize,
  };

  let mailboxId: number | null;
  try {
    mailboxId = await findActiveMailbox(env.DB, recipient);
  } catch (error) {
    return fallback(message, env, context, "mailbox_lookup_failed", error);
  }

  if (mailboxId === null) {
    log({ ...context, event: "rejected", status: "unknown_recipient" });
    message.setReject("Unknown recipient");
    return;
  }
  if (message.rawSize > MAX_MESSAGE_BYTES) {
    log({ ...context, event: "rejected", status: "too_large" });
    message.setReject("Message too large: the limit is 25 MiB");
    return;
  }

  const id = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  try {
    // The raw stream can be read only once.
    const raw = await new Response(message.raw).arrayBuffer();
    const dedupeKey = await dedupeKeyFor(
      message.headers.get("Message-ID"),
      raw,
    );

    if (await isDuplicate(env.DB, mailboxId, dedupeKey)) {
      log({ ...context, event: "duplicate", status: "skipped" });
      return;
    }

    const rawKey = `raw/${receivedAt.slice(0, 4)}/${receivedAt.slice(5, 7)}/${id}.eml`;
    // The metadata alone is enough to reprocess the object: a Bcc recipient is not in the headers.
    await env.MAIL.put(rawKey, raw, {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        mailboxId: String(mailboxId),
        envelopeTo: message.to,
        envelopeFrom: message.from,
        receivedAt,
        dedupeKey,
      },
    });

    const job: IngestJob = {
      id,
      rawKey,
      mailboxId,
      dedupeKey,
      receivedAt,
      size: raw.byteLength,
    };
    await env.INGEST_QUEUE.send(job);
    log({ ...context, event: "queued", messageId: id, status: "queued" });
  } catch (error) {
    return fallback(
      message,
      env,
      { ...context, messageId: id },
      "store_failed",
      error,
    );
  }
}

async function findActiveMailbox(
  db: D1Database,
  address: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT m.id FROM mailboxes m JOIN domains d ON d.id = m.domain_id
       WHERE m.address = ?1 AND m.active = 1 AND d.active = 1`,
    )
    .bind(address)
    .first<{ id: number }>();
  return row?.id ?? null;
}

async function isDuplicate(
  db: D1Database,
  mailboxId: number,
  dedupeKey: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS found FROM messages WHERE mailbox_id = ?1 AND message_id = ?2",
    )
    .bind(mailboxId, dedupeKey)
    .first();
  return row !== null;
}

export async function dedupeKeyFor(
  header: string | null,
  raw: ArrayBuffer,
): Promise<string> {
  const messageId = header?.trim();
  if (messageId && messageId.length <= MAX_MESSAGE_ID_LENGTH) return messageId;
  return `sha256:${await sha256Hex(messageId || raw)}`;
}

/**
 * Forwards the message to the verified fallback address. With no usable fallback, or if the
 * forward fails too, rethrows so Email Routing treats it as an internal error, never a rejection.
 */
async function fallback(
  message: ForwardableEmailMessage,
  env: Env,
  context: LogEntry,
  status: string,
  error: unknown,
): Promise<void> {
  log({ ...context, event: "internal_error", status, error: errorName(error) });

  const target = env.FALLBACK_FORWARD_TO?.trim().toLowerCase();
  // A fallback on the recipient's own domain would route straight back to this Worker.
  if (!target || domainOf(target) === domainOf(message.to)) {
    log({ ...context, event: "fallback_unavailable" });
    throw error;
  }

  try {
    await message.forward(target);
    log({ ...context, event: "forwarded_to_fallback" });
  } catch (forwardError) {
    log({
      ...context,
      event: "fallback_failed",
      error: errorName(forwardError),
    });
    throw error;
  }
}
