import { type ResourceLimits, Worker } from "node:worker_threads";
import { log } from "./log.ts";
import type { Sanitized } from "./sanitize.ts";

/** Above this, the HTML is not sanitized: the page shows the text and the .eml button (docs/webmail-leitura.md). */
export const MAX_HTML_BYTES = 1024 * 1024;

export type SanitizeResult =
  | ({ ok: true } & Sanitized)
  | { ok: false; reason: "too_large" | "busy" | "failed" | "unavailable" };

interface Options {
  size?: number;
  timeoutMs?: number;
  resourceLimits?: ResourceLimits;
  /** Tests only: where the worker file comes from (a probe worker, or a failing load). */
  load?: () => Promise<URL>;
}

/**
 * At most `size` sanitizations at once, each in its own worker thread: the work is synchronous
 * and would block every other request (logins included) on the main thread. A worker that times
 * out, runs out of memory or dies is terminated and replaced, never reused.
 */
export function createSanitizePool({
  size = 2,
  timeoutMs = 10_000,
  // Measured: two workers at this limit take the process to about 1.4 GiB of RSS; the
  // container limit (2 GiB) sits above that, so a worker dies before the container does
  // (docs/webmail-leitura.md, "Memória real").
  resourceLimits = { maxOldGenerationSizeMb: 512 },
  // Dynamic import: the build puts sanitize.ts in its own chunk, which the worker then runs.
  load = () => import("./sanitize.ts").then((m) => new URL(m.WORKER_URL)),
}: Options = {}) {
  let workerFile: Promise<URL> | undefined;
  const resolveFile = () => {
    // A failed load is not kept: the next request tries again.
    workerFile ??= load().catch((err: unknown) => {
      workerFile = undefined;
      throw err;
    });
    return workerFile;
  };
  type Slot = { worker: Worker | null; busy: boolean };
  const spawn = (slot: Slot, file: URL) => {
    // env {}: this thread parses HTML from strangers and gets none of the process variables
    // (INTERNAL_API_TOKEN, TOTP_ENCRYPTION_KEY, ...).
    // execArgv []: no flags (such as --inspect) inherited from the main process.
    const worker = new Worker(file, { env: {}, execArgv: [], resourceLimits });
    worker.unref();
    // A worker that dies while idle is not reused either.
    worker.once("exit", () => {
      if (slot.worker === worker) slot.worker = null;
    });
    return worker;
  };
  const slots: Slot[] = Array.from({ length: size }, () => ({
    worker: null,
    busy: false,
  }));

  return {
    async run(html: string): Promise<SanitizeResult> {
      if (Buffer.byteLength(html) > MAX_HTML_BYTES)
        return { ok: false, reason: "too_large" };
      // Taken before any await, so a third request never finds a free slot.
      const slot = slots.find((s) => !s.busy);
      if (!slot) return { ok: false, reason: "busy" };
      slot.busy = true;
      let worker: Worker;
      try {
        worker = slot.worker ??= spawn(slot, await resolveFile());
      } catch {
        // Nothing about the message or the error: the error text could carry file paths.
        log("error", "sanitizer_unavailable");
        slot.busy = false;
        return { ok: false, reason: "unavailable" };
      }
      return new Promise((resolve) => {
        const finish = (result: SanitizeResult, replace: boolean) => {
          clearTimeout(timer);
          worker.off("message", onMessage);
          worker.off("error", onFailure);
          worker.off("exit", onFailure);
          if (replace) {
            slot.worker = null;
            void worker.terminate();
          }
          slot.busy = false;
          resolve(result);
        };
        const onMessage = (out: Sanitized) =>
          finish({ ok: true, ...out }, false);
        const onFailure = () => finish({ ok: false, reason: "failed" }, true);
        const timer = setTimeout(onFailure, timeoutMs);
        worker.on("message", onMessage);
        worker.on("error", onFailure);
        worker.on("exit", onFailure);
        worker.postMessage(html);
      });
    },
  };
}

export type SanitizePool = ReturnType<typeof createSanitizePool>;
