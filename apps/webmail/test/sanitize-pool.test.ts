import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createSanitizePool,
  MAX_HTML_BYTES,
} from "../src/lib/server/sanitize-pool.ts";
import { MALICIOUS_HTML } from "./fixtures/emails.ts";

const probeFile = new URL("./fixtures/probe-worker.ts", import.meta.url);
const probe = async () => probeFile;
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
    const pool = createSanitizePool({ load: probe });
    expect(Object.keys(process.env).length).toBeGreaterThan(1);
    expect(await html(pool.run("env"))).toBe("[]");
  });

  it("reuses a healthy worker", async () => {
    const pool = createSanitizePool({ size: 1, load: probe });
    const first = await html(pool.run("id"));
    expect(await html(pool.run("id"))).toBe(first);
  });

  it("terminates a worker that hangs and never reuses it", async () => {
    const pool = createSanitizePool({ size: 1, timeoutMs: 300, load: probe });
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
      load: probe,
    });
    const first = await html(pool.run("id"));
    expect(await html(pool.run("oom"))).toBe("failed");
    expect(await html(pool.run("id"))).not.toBe(first);
  });

  it("answers busy when every worker is taken", async () => {
    const pool = createSanitizePool({ size: 2, timeoutMs: 500, load: probe });
    const a = pool.run("hang");
    const b = pool.run("hang");
    expect(await pool.run("id")).toEqual({ ok: false, reason: "busy" });
    expect([await html(a), await html(b)]).toEqual(["failed", "failed"]);
    // Both slots free again, with new workers.
    expect(await html(pool.run("id"))).toMatch(/^\d+$/);
  });

  it("refuses HTML above 1 MB without starting a worker", async () => {
    const pool = createSanitizePool({ load: probe });
    expect(await pool.run("x".repeat(MAX_HTML_BYTES + 1))).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("logs sanitizer_unavailable without details and tries the load again next time", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let loads = 0;
    const pool = createSanitizePool({
      size: 1,
      load: async () => {
        loads++;
        if (loads === 1) throw new Error("/secret/path/sanitize.js not found");
        return probeFile;
      },
    });
    expect(await pool.run("<p>mensagem</p>")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(errors).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(errors.mock.calls[0]?.[0]));
    expect(Object.keys(line).sort()).toEqual(["event", "level", "time"]);
    expect(line).toMatchObject({
      level: "error",
      event: "sanitizer_unavailable",
    });
    // The rejected load was not kept: the next request loads again and works.
    expect(await html(pool.run("id"))).toMatch(/^\d+$/);
    expect(loads).toBe(2);
    errors.mockRestore();
  });

  // Two workers at the heap limit at once (docs/webmail-leitura.md, "Memória real"): each one
  // must die by itself, well before the process reaches the container limit (2 GiB).
  it("two workers blowing the heap at once stay under the memory budget", async () => {
    const rssMiB = () =>
      Number(
        /VmRSS:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1],
      ) / 1024;
    const pool = createSanitizePool();
    await Promise.all([pool.run("<p>a</p>"), pool.run("<p>b</p>")]);
    const before = rssMiB();
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, rssMiB());
    }, 20);
    // 240,000 <br> (938 KB, under the 1 MB limit): measured to blow the 512 MB heap in ~6 s.
    const bomb = "<br>".repeat(240_000);
    const results = await Promise.all([pool.run(bomb), pool.run(bomb)]);
    clearInterval(sampler);
    expect(results).toEqual([
      { ok: false, reason: "failed" },
      { ok: false, reason: "failed" },
    ]);
    // Measured: about +1000 MiB for both. 1200 leaves room for runner noise and stays far
    // below 2 GiB minus the server itself.
    expect(peak - before).toBeLessThan(1200);
  }, 60_000);

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
