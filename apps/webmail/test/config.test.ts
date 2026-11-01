import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/lib/server/config.ts";

const base = {
  MAIL_API_URL: "https://mail-api.example.test",
  INTERNAL_API_TOKEN: "test-internal",
  CF_ACCESS_CLIENT_ID: "test-id",
  CF_ACCESS_CLIENT_SECRET: "test-secret",
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("loadConfig", () => {
  it("refuses production without ADDRESS_HEADER=cf-connecting-ip, whatever NODE_ENV says", () => {
    expect(() => loadConfig(true, base)).toThrow(/ADDRESS_HEADER/);
    expect(() =>
      loadConfig(true, { ...base, NODE_ENV: "development" }),
    ).toThrow(/ADDRESS_HEADER/);
    expect(() =>
      loadConfig(true, { ...base, ADDRESS_HEADER: "x-forwarded-for" }),
    ).toThrow();
    expect(
      loadConfig(true, { ...base, ADDRESS_HEADER: "CF-Connecting-IP" })
        .production,
    ).toBe(true);
  });
  it("allows the socket address only in vite dev", () => {
    expect(
      loadConfig(false, { ...base, NODE_ENV: "production" }).production,
    ).toBe(false);
  });
  it("refuses the TOTP keys published in .env.example", async () => {
    const { readFileSync } = await import("node:fs");
    const example = /^TOTP_ENCRYPTION_KEY=(.*)$/m.exec(
      readFileSync(new URL("../.env.example", import.meta.url), "utf8"),
    )?.[1];
    expect(example).toBeTruthy();
    for (const key of [example, "ZmFrZS1rZXktZmFrZS1rZXktZmFrZS1rZXktZmFrZSE="])
      expect(() =>
        loadConfig(false, { ...base, TOTP_ENCRYPTION_KEY: key }),
      ).toThrow(/example value/);
  });
  it("refuses a missing value, a short key and plain http to a remote host", () => {
    expect(() =>
      loadConfig(false, { ...base, INTERNAL_API_TOKEN: "" }),
    ).toThrow(/INTERNAL_API_TOKEN/);
    expect(() =>
      loadConfig(false, { ...base, TOTP_ENCRYPTION_KEY: "c2hvcnQ=" }),
    ).toThrow(/32 bytes/);
    expect(() =>
      loadConfig(false, {
        ...base,
        MAIL_API_URL: "http://mail-api.example.test",
      }),
    ).toThrow(/https/);
    expect(
      loadConfig(false, { ...base, MAIL_API_URL: "http://127.0.0.1:8790" }).api
        .apiUrl,
    ).toBe("http://127.0.0.1:8790");
  });
});
