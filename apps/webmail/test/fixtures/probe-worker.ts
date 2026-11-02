// A stand-in for sanitize.ts in sanitize-pool.test.ts. "env": the variables this thread sees;
// "hang": never answers; "oom": allocates until the heap limit kills the thread; anything else:
// the thread id, to tell a reused worker from a new one.
import { parentPort, threadId } from "node:worker_threads";

const port = parentPort;
const hold: number[][] = [];
port?.on("message", (message: string) => {
  if (message === "hang") for (;;);
  if (message === "oom") for (;;) hold.push(new Array(1_000_000).fill(1));
  const html =
    message === "env"
      ? JSON.stringify(Object.keys(process.env))
      : String(threadId);
  port.postMessage({ html, blockedImages: 0 });
});
