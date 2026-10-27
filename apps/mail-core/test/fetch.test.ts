import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index";

it("answers 404 to every HTTP request", async () => {
  for (const path of ["/", "/api/messages", "/admin"]) {
    const response = await worker.fetch(
      new Request(`https://mail-core.test${path}`),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
  }
});
