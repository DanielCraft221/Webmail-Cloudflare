import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/lib/server/secret-box.ts";

const key = randomBytes(32);
const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";

describe("secret box", () => {
  it("round-trips with the same user id", () => {
    const enc = encryptSecret(key, alice, "JBSWY3DPEHPK3PXP");
    expect(enc).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(decryptSecret(key, alice, enc)).toBe("JBSWY3DPEHPK3PXP");
  });
  it("fails for another user's id (AAD), another key or a changed byte", () => {
    const enc = encryptSecret(key, alice, "JBSWY3DPEHPK3PXP");
    expect(() => decryptSecret(key, bob, enc)).toThrow();
    expect(() => decryptSecret(randomBytes(32), alice, enc)).toThrow();
    const [v, iv, body] = enc.split(".");
    const bytes = Buffer.from(body ?? "", "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() =>
      decryptSecret(key, alice, `${v}.${iv}.${bytes.toString("base64url")}`),
    ).toThrow();
    expect(() => decryptSecret(key, alice, "v2.a.b")).toThrow();
  });
});
