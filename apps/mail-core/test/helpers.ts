import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index";
import type { IngestJob } from "../src/ingest";

export const FALLBACK = "reserva@example.org";

/** Test env: queue sends are captured instead of delivered, and a fallback address is set. */
export function testEnv(overrides: Partial<Env> = {}): {
  env: Env;
  jobs: IngestJob[];
} {
  const jobs: IngestJob[] = [];
  const queue = {
    send: async (job: IngestJob) => {
      jobs.push(job);
    },
  } as unknown as Queue;
  return {
    env: {
      ...env,
      INGEST_QUEUE: queue,
      FALLBACK_FORWARD_TO: FALLBACK,
      ...overrides,
    },
    jobs,
  };
}

export function fakeEmail(
  raw: string,
  options: {
    to?: string;
    from?: string;
    rawSize?: number;
    forwardFails?: boolean;
  } = {},
) {
  const bytes = new TextEncoder().encode(raw);
  const headers = new Headers();
  const messageId = /^message-id:\s*(.+)$/im.exec(
    raw.split(/\n\r?\n/)[0] ?? "",
  )?.[1];
  if (messageId) headers.set("Message-ID", messageId.trim());
  const setReject = vi.fn();
  const forward = vi.fn(async () => {
    if (options.forwardFails) throw new Error("Forward failed");
    return { messageId: "forwarded" };
  });
  const message = {
    from: options.from ?? "ana.teste@example.net",
    to: options.to ?? "contato@survivus.com.br",
    headers,
    raw: new Response(bytes).body,
    rawSize: options.rawSize ?? bytes.byteLength,
    setReject,
    forward,
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
  return { message, setReject, forward };
}

export async function deliver(
  raw: string,
  options: Parameters<typeof fakeEmail>[1] & {
    env?: ReturnType<typeof testEnv>;
  } = {},
) {
  const target = options.env ?? testEnv();
  const email = fakeEmail(raw, options);
  await worker.email(email.message, target.env);
  return { ...email, jobs: target.jobs };
}

export async function runQueue(
  job: IngestJob,
  targetEnv: Env = env,
  attempts = 1,
) {
  const batch = createMessageBatch<IngestJob>("mail-ingest", [
    { id: job.id, timestamp: new Date(), attempts, body: job },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, targetEnv);
  return getQueueResult(batch, ctx);
}

/** Delivers and runs the consumer for every queued job. */
export async function deliverAndIngest(
  raw: string,
  options: Parameters<typeof deliver>[1] = {},
) {
  const result = await deliver(raw, options);
  for (const job of result.jobs) await runQueue(job);
  return result;
}

export async function messages() {
  const { results } = await env.DB.prepare(
    "SELECT * FROM messages ORDER BY received_at",
  ).all<Record<string, unknown>>();
  return results;
}

export async function attachments() {
  const { results } = await env.DB.prepare("SELECT * FROM attachments").all<
    Record<string, unknown>
  >();
  return results;
}

export async function r2Keys(prefix = ""): Promise<string[]> {
  const listed = await env.MAIL.list({ prefix });
  return listed.objects.map((o) => o.key).sort();
}

export async function reset() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM attachments"),
    env.DB.prepare("DELETE FROM messages"),
  ]);
  const keys = await r2Keys();
  if (keys.length > 0) await env.MAIL.delete(keys);
}

export async function mailboxId(address: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address = ?1",
  )
    .bind(address)
    .first<{ id: number }>();
  if (!row) throw new Error(`No mailbox ${address}`);
  return row.id;
}
