import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ingest, retryDelaySeconds } from "../src/ingest";
import dmarcFail from "./fixtures/dmarc-fail.eml?raw";
import forgedAuth from "./fixtures/forged-auth.eml?raw";
import htmlAttachment from "./fixtures/html-attachment.eml?raw";
import plain from "./fixtures/plain.eml?raw";
import {
  attachments,
  deliver,
  messages,
  r2Keys,
  reset,
  runQueue,
} from "./helpers";

beforeEach(reset);

/** D1 that accepts reads but fails every batch write. */
const failingWrites = {
  prepare: (query: string) => env.DB.prepare(query),
  batch: () => Promise.reject(new Error("D1 unavailable")),
} as unknown as D1Database;

describe("queue consumer: failures and retries", () => {
  it("retries on a D1 failure without losing the message", async () => {
    const [job] = (
      await deliver(htmlAttachment, { to: "suporte@survivus.com.br" })
    ).jobs;
    if (!job) throw new Error("no job");

    const failed = await runQueue(job, { ...env, DB: failingWrites });
    expect(failed.retryMessages.map((m) => m.msgId)).toEqual([job.id]);
    expect(failed.explicitAcks).toEqual([]);
    expect(await messages()).toEqual([]);
    expect(await env.MAIL.head(job.rawKey)).not.toBeNull();

    // The retry reuses the same R2 keys: no orphan attachment objects.
    const retried = await runQueue(job, env, 2);
    expect(retried.explicitAcks).toEqual([job.id]);
    expect(await messages()).toHaveLength(1);
    const rows = await attachments();
    expect(await r2Keys("att/")).toEqual(rows.map((a) => a.r2_key).sort());
  });

  it("acks a job that was already stored by an earlier attempt", async () => {
    const [job] = (await deliver(plain)).jobs;
    if (!job) throw new Error("no job");
    await runQueue(job);
    expect(await ingest(job, env)).toBe("already_stored");
    expect(await env.MAIL.head(job.rawKey)).not.toBeNull();
  });

  it("keeps one copy when two deliveries of the same message race", async () => {
    // Both pass the handler's duplicate check before either is stored.
    const [first] = (await deliver(plain)).jobs;
    const [second] = (await deliver(plain)).jobs;
    if (!first || !second) throw new Error("no job");

    expect(await ingest(first, env)).toBe("stored");
    expect(await ingest(second, env)).toBe("duplicate");
    expect(await messages()).toHaveLength(1);
    expect(await env.MAIL.head(second.rawKey)).toBeNull();
    expect(await r2Keys("body/")).toEqual([`body/${first.id}.json`]);
  });

  it("backs off 30 s doubling, capped at 1 h", () => {
    expect([1, 2, 3, 7, 8, 10].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 1920, 3600, 3600,
    ]);
  });
});

describe("queue consumer: authentication results", () => {
  const trusted = ["mx.trusted.test"];

  it("moves a DMARC failure to spam when the header is trusted", async () => {
    const [job] = (await deliver(dmarcFail)).jobs;
    if (!job) throw new Error("no job");
    await ingest(job, env, trusted);
    const [row] = await messages();
    expect(row).toMatchObject({
      folder: "spam",
      spf: "fail",
      dkim: "none",
      dmarc: "fail",
    });
  });

  it("ignores a forged dmarc=pass when no Cloudflare header exists", async () => {
    const [job] = (await deliver(forgedAuth)).jobs;
    if (!job) throw new Error("no job");
    await ingest(job, env, trusted);
    const [row] = await messages();
    expect(row).toMatchObject({
      folder: "inbox",
      spf: "unknown",
      dkim: "unknown",
      dmarc: "unknown",
    });
  });
});
