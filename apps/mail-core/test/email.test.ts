import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES } from "../src/email";
import broken from "./fixtures/broken.eml?raw";
import dmarcFail from "./fixtures/dmarc-fail.eml?raw";
import htmlAttachment from "./fixtures/html-attachment.eml?raw";
import noMessageId from "./fixtures/no-message-id.eml?raw";
import plain from "./fixtures/plain.eml?raw";
import {
  attachments,
  deliver,
  deliverAndIngest,
  FALLBACK,
  mailboxId,
  messages,
  r2Keys,
  reset,
  testEnv,
} from "./helpers";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

beforeEach(reset);

describe("email handler: recipient and size", () => {
  it("rejects an unknown recipient and stores nothing", async () => {
    const { setReject, jobs } = await deliver(plain, {
      to: "naoexiste@survivus.com.br",
    });
    expect(setReject).toHaveBeenCalledWith("Unknown recipient");
    expect(jobs).toEqual([]);
    expect(await r2Keys()).toEqual([]);
    expect(await messages()).toEqual([]);
  });

  it("accepts an uppercase recipient in the right mailbox", async () => {
    const { setReject } = await deliverAndIngest(plain, {
      to: "Contato@Survivus.com.br",
    });
    expect(setReject).not.toHaveBeenCalled();
    const [row] = await messages();
    expect(row?.mailbox_id).toBe(await mailboxId("contato@survivus.com.br"));
  });

  it("rejects a message over the size limit", async () => {
    const { setReject, jobs } = await deliver(plain, {
      rawSize: MAX_MESSAGE_BYTES + 1,
    });
    expect(setReject).toHaveBeenCalledWith(expect.stringContaining("25 MiB"));
    expect(jobs).toEqual([]);
    expect(await r2Keys()).toEqual([]);
  });
});

describe("email handler and consumer: storing", () => {
  it("stores a plain text message: .eml, body and a messages row", async () => {
    await deliverAndIngest(plain);
    const [row] = await messages();
    expect(row).toMatchObject({
      folder: "inbox",
      message_id: "<plain-0001@example.net>",
      from_address: "ana.teste@example.net",
      from_name: "Ana Teste",
      subject: "Orcamento sigiloso 4471",
      parse_status: "ok",
      has_attachments: 0,
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
      is_read: 0,
    });
    expect(row?.raw_key).toMatch(
      new RegExp(`^raw/\\d{4}/\\d{2}/${UUID}\\.eml$`),
    );
    expect(row?.body_key).toBe(`body/${row?.id}.json`);
    expect(String(row?.snippet)).toContain("Corpo de teste");

    const body = await env.MAIL.get(String(row?.body_key));
    expect(JSON.parse((await body?.text()) ?? "")).toMatchObject({
      text: expect.stringContaining("Corpo de teste"),
    });
  });

  it("stores the envelope in the .eml custom metadata", async () => {
    // Bcc-like: the envelope recipient is not in the To header.
    const { jobs } = await deliver(plain, {
      to: "compras@survivus.com.br",
      from: "bounce+x@example.net",
    });
    const job = jobs[0];
    const object = await env.MAIL.head(String(job?.rawKey));
    expect(object?.httpMetadata?.contentType).toBe("message/rfc822");
    expect(object?.customMetadata).toEqual({
      mailboxId: String(await mailboxId("compras@survivus.com.br")),
      envelopeTo: "compras@survivus.com.br",
      envelopeFrom: "bounce+x@example.net",
      receivedAt: job?.receivedAt,
      dedupeKey: job?.dedupeKey,
    });
    expect(job?.dedupeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("stores an HTML message with an attachment under a UUID key", async () => {
    await deliverAndIngest(htmlAttachment, { to: "suporte@survivus.com.br" });
    const [row] = await messages();
    expect(row?.has_attachments).toBe(1);
    expect(JSON.parse(String(row?.cc_json))).toEqual([
      { address: "carla@example.org", name: "Carla" },
    ]);

    const [attachment] = await attachments();
    expect(attachment).toMatchObject({
      message_id: row?.id,
      filename: "relatorio-interno-9931.pdf",
      content_type: "application/pdf",
      is_inline: 0,
    });
    expect(attachment?.r2_key).toMatch(new RegExp(`^att/${row?.id}/${UUID}$`));
    expect(String(attachment?.r2_key)).not.toContain("relatorio");
    const object = await env.MAIL.get(String(attachment?.r2_key));
    expect(object?.httpMetadata?.contentType).toBe("application/pdf");
    expect(object?.size).toBe(attachment?.size);
  });

  it("stores a real duplicate under dup/ with the same metadata, without queueing", async () => {
    const first = await deliverAndIngest(plain);
    const second = await deliver(plain);
    expect(second.jobs).toEqual([]);
    expect(second.setReject).not.toHaveBeenCalled();
    expect(await messages()).toHaveLength(1);
    expect(await r2Keys("raw/")).toHaveLength(1);

    const [dupKey] = await r2Keys("dup/");
    expect(dupKey).toMatch(new RegExp(`^dup/\\d{4}/\\d{2}/${UUID}\\.eml$`));
    const dup = await env.MAIL.get(String(dupKey));
    expect(await dup?.text()).toBe(plain);
    expect(dup?.customMetadata).toMatchObject({
      mailboxId: String(await mailboxId("contato@survivus.com.br")),
      envelopeTo: "contato@survivus.com.br",
      dedupeKey: first.jobs[0]?.dedupeKey,
    });
  });

  it("treats the same Message-ID with a different subject as a new message", async () => {
    await deliverAndIngest(plain);
    await deliverAndIngest(
      plain.replace(
        "Subject: Orcamento sigiloso 4471",
        "Subject: Outro assunto",
      ),
    );
    const rows = await messages();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.message_id)).toEqual([
      "<plain-0001@example.net>",
      "<plain-0001@example.net>",
    ]);
    expect(await r2Keys("dup/")).toEqual([]);
  });

  it("deduplicates a message without Message-ID by its hash", async () => {
    const first = await deliverAndIngest(noMessageId, {
      to: "compras@survivus.com.br",
    });
    expect(first.jobs[0]?.dedupeKey).toMatch(/^sha256:[0-9a-f]{64}$/);
    const second = await deliver(noMessageId, {
      to: "compras@survivus.com.br",
    });
    expect(second.jobs).toEqual([]);
    expect(await messages()).toHaveLength(1);
    expect(await r2Keys("dup/")).toHaveLength(1);
  });

  it("records broken MIME as parse_status failed and keeps the .eml", async () => {
    await deliverAndIngest(broken);
    const [row] = await messages();
    expect(row).toMatchObject({
      parse_status: "failed",
      subject: "MIME quebrado",
      body_key: null,
    });
    expect(await env.MAIL.head(String(row?.raw_key))).not.toBeNull();
  });

  it("keeps DMARC results unknown while no authserv-id is trusted", async () => {
    await deliverAndIngest(dmarcFail);
    const [row] = await messages();
    expect(row).toMatchObject({ folder: "inbox", dmarc: "unknown" });
  });
});

describe("email handler: internal errors never reject", () => {
  const failingDb = {
    prepare: () => {
      throw new Error("D1 unavailable");
    },
  } as unknown as D1Database;

  it("forwards to the fallback when D1 fails", async () => {
    const { setReject, forward, jobs } = await deliver(plain, {
      env: testEnv({ DB: failingDb }),
    });
    expect(setReject).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(FALLBACK);
    expect(jobs).toEqual([]);
  });

  it("forwards to the fallback when R2 fails", async () => {
    const failingR2 = {
      put: () => Promise.reject(new Error("R2 unavailable")),
    } as unknown as R2Bucket;
    const { setReject, forward } = await deliver(plain, {
      env: testEnv({ MAIL: failingR2 }),
    });
    expect(setReject).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(FALLBACK);
  });

  it("forwards to the fallback when the queue fails, keeping the .eml in R2", async () => {
    const target = testEnv();
    target.env.INGEST_QUEUE = {
      send: () => Promise.reject(new Error("Queue unavailable")),
    } as unknown as Queue;
    const { setReject, forward } = await deliver(plain, { env: target });
    expect(setReject).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledWith(FALLBACK);
    expect(await r2Keys("raw/")).toHaveLength(1);
  });

  it("rethrows the original error when the forward fails too", async () => {
    const target = testEnv({ DB: failingDb });
    await expect(
      deliver(plain, { env: target, forwardFails: true }),
    ).rejects.toThrow("D1 unavailable");
  });

  it("rethrows without forwarding when no fallback is configured", async () => {
    const target = testEnv({ DB: failingDb });
    delete target.env.FALLBACK_FORWARD_TO;
    await expect(deliver(plain, { env: target })).rejects.toThrow(
      "D1 unavailable",
    );
  });

  it("refuses a fallback on the recipient's own domain", async () => {
    const target = testEnv({
      DB: failingDb,
      FALLBACK_FORWARD_TO: "suporte@survivus.com.br",
    });
    await expect(deliver(plain, { env: target })).rejects.toThrow(
      "D1 unavailable",
    );
  });
});
