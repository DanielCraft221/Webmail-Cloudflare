import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleError } from "../src/hooks.server.ts";

// Kit's virtual module only exists inside the kit build.
vi.mock("$app/env", () => ({ dev: false }));

describe("handleError", () => {
  it("logs the route pattern, never the real path with the link token", () => {
    const token = randomBytes(32).toString("base64url");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = {
      kind: "unknown",
      error: new TypeError(`boom /setup/${token}`),
      event: {
        route: { id: "/setup/[token]" },
        url: new URL(`http://localhost/setup/${token}`),
        params: { token },
      },
    } as unknown as Parameters<typeof handleError>[0];
    const result = handleError(input);
    const logged = spy.mock.calls.flat().join("\n");
    spy.mockRestore();
    expect(result).toEqual({ message: "Erro interno." });
    expect(JSON.parse(logged)).toMatchObject({
      event: "unexpected_error",
      route: "/setup/[token]",
      kind: "TypeError",
    });
    expect(logged).not.toContain(token);
  });
});
