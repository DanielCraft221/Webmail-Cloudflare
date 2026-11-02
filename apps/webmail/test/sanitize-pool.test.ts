import { readdirSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  createSanitizePool,
  MAX_HTML_BYTES,
} from "../src/lib/server/sanitize-pool.ts";
import { MALICIOUS_HTML } from "./fixtures/emails.ts";

const probe = new URL("./fixtures/probe-worker.ts", import.meta.url);
const html = async (
  p: Promise<{ ok: boolean; html?: string; reason?: string }>,
) => {
  const r = await p;
  return r.ok ? r.html : r.reason;
};

describe("sanitize pool", () => {
  // A variable the worker must not see, set like the real secrets (env_file in the compose).
  process.env.INTERNAL_API_TOKEN = "test-value-the-worker-must-not-see";
  afterAll(() => {
    delete process.env.INTERNAL_API_TOKEN;
  });

  it("starts each worker with an empty environment", async () => {
    const pool = createSanitizePool({ file: probe });
    expect(Object.keys(process.env).length).toBeGreaterThan(1);
    expect(await html(pool.run("env"))).toBe("[]");
  });

  it("reuses a healthy worker", async () => {
    const pool = createSanitizePool({ size: 1, file: probe });
    const first = await html(pool.run("id"));
    expect(await html(pool.run("id"))).toBe(first);
  });

  it("terminates a worker that hangs and never reuses it", async () => {
    const pool = createSanitizePool({ size: 1, timeoutMs: 300, file: probe });
    const first = await html(pool.run("id"));
    // OS threads of this process (Linux): the hung thread must really stop, not just be forgotten.
    const threads = () => readdirSync("/proc/self/task").length;
    const before = threads();
    expect(await html(pool.run("hang"))).toBe("failed");
    await sleep(500);
    expect(threads()).toBeLessThan(before);
    const next = await html(pool.run("id"));
    expect(next).not.toBe(first);
    expect(Number(next)).toBeGreaterThan(Number(first));
  });

  it("terminates a worker that runs out of memory and never reuses it", async () => {
    const pool = createSanitizePool({
      size: 1,
      timeoutMs: 20_000,
      resourceLimits: { maxOldGenerationSizeMb: 32 },
      file: probe,
    });
    const first = await html(pool.run("id"));
    expect(await html(pool.run("oom"))).toBe("failed");
    expect(await html(pool.run("id"))).not.toBe(first);
  });

  it("answers busy when every worker is taken", async () => {
    const pool = createSanitizePool({ size: 2, timeoutMs: 500, file: probe });
    const a = pool.run("hang");
    const b = pool.run("hang");
    expect(await pool.run("id")).toEqual({ ok: false, reason: "busy" });
    expect([await html(a), await html(b)]).toEqual(["failed", "failed"]);
    // Both slots free again, with new workers.
    expect(await html(pool.run("id"))).toMatch(/^\d+$/);
  });

  it("refuses HTML above 1 MB without starting a worker", async () => {
    const pool = createSanitizePool({ file: probe });
    expect(await pool.run("x".repeat(MAX_HTML_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("runs the real sanitizer in a worker", async () => {
    const pool = createSanitizePool();
    const result = await pool.run(MALICIOUS_HTML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(
      /<script|onerror|onload|evil\.example\/(frame|phish)/i,
    );
    expect(result.html).toContain("Olá, esta é uma mensagem de teste.");
    // The tracker and the relative src="x" (it would load from the webmail itself).
    expect(result.blockedImages).toBe(2);
  }, 20_000);
});
