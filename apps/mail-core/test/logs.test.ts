import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import htmlAttachment from "./fixtures/html-attachment.eml?raw";
import plain from "./fixtures/plain.eml?raw";
import { deliver, deliverAndIngest, reset, testEnv } from "./helpers";

beforeEach(reset);
afterEach(() => vi.restoreAllMocks());

function captureLogs(): () => string {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
  return () => lines.join("\n");
}

describe("logs", () => {
  it("never contain the subject, body, attachment name or full sender address", async () => {
    const output = captureLogs();
    await deliverAndIngest(plain);
    await deliverAndIngest(htmlAttachment, {
      to: "suporte@survivus.com.br",
      from: "bruno@example.org",
    });
    await deliver(plain, { to: "naoexiste@survivus.com.br" });
    const failing = testEnv({
      DB: {
        prepare: () => {
          throw new Error("D1 unavailable");
        },
      } as unknown as D1Database,
    });
    await expect(deliver(plain, { env: failing })).rejects.toThrow();

    const logged = output();
    expect(logged).toContain('"event":"queued"');
    expect(logged).toContain('"event":"internal_error"');
    expect(logged).toContain('"senderDomain":"example.net"');
    for (const secret of [
      "Orcamento sigiloso",
      "Corpo de teste",
      "Relatorio com anexo",
      "relatorio-interno-9931",
      "ana.teste@example.net",
      "bruno@example.org",
      "Ana Teste",
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it("logs a duplicate with only its UUID and the dedupe key hash", async () => {
    await deliverAndIngest(plain);
    const output = captureLogs();
    await deliver(plain);

    const entries = output()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const duplicate = entries.find((e) => e.event === "duplicate");
    expect(duplicate).toEqual({
      event: "duplicate",
      mailbox: "contato@survivus.com.br",
      senderDomain: "example.net",
      size: plain.length,
      messageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: "stored_as_duplicate",
      dedupeKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    for (const secret of [
      "Orcamento sigiloso",
      "Corpo de teste",
      "ana.teste@example.net",
      "plain-0001",
    ]) {
      expect(output()).not.toContain(secret);
    }
  });
});
