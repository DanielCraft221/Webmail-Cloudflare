import { argon2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Argon2Busy,
  hashPassword,
  passwordProblem,
  verifyPassword,
} from "../src/lib/server/password.ts";

describe("crypto.argon2", () => {
  // RFC 9106, section 5.3. Breaks if the Node API or its output ever changes.
  it("matches the argon2id test vector", () => {
    const tag = argon2Sync("argon2id", {
      message: Buffer.alloc(32, 0x01),
      nonce: Buffer.alloc(16, 0x02),
      secret: Buffer.alloc(8, 0x03),
      associatedData: Buffer.alloc(12, 0x04),
      memory: 32,
      passes: 3,
      parallelism: 4,
      tagLength: 32,
    });
    expect(tag.toString("hex")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );
  });
});

describe("hashPassword / verifyPassword", () => {
  it("stores a PHC string with the chosen parameters and verifies it", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "correct horse batterY")).toBe(false);
  });
  it("returns false for a malformed or oversized hash", async () => {
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
    expect(
      await verifyPassword("$argon2id$v=19$m=999999999,t=3,p=1$AAAA$AAAA", "x"),
    ).toBe(false);
  });
  it("refuses a third run at the same time", async () => {
    const runs = [hashPassword("a"), hashPassword("b"), hashPassword("c")];
    const results = await Promise.allSettled(runs);
    const busy = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof Argon2Busy,
    );
    expect(busy).toHaveLength(1);
    // The slots are free again afterwards.
    await expect(hashPassword("d")).resolves.toMatch(/^\$argon2id/);
  });
});

describe("passwordProblem", () => {
  it("applies length and username rules only", () => {
    expect(passwordProblem("a".repeat(11), "ana")).toMatch(/12/);
    expect(passwordProblem("a".repeat(129), "ana")).toMatch(/128/);
    expect(passwordProblem("joao.da.silva", "joao.da.silva")).toMatch(
      /usuário/,
    );
    expect(passwordProblem("aaaaaaaaaaaa", "ana")).toBeNull();
    // Length is in characters: 12 emoji pass, even though they are 48 bytes.
    expect(passwordProblem("🔑".repeat(12), "ana")).toBeNull();
  });
});
