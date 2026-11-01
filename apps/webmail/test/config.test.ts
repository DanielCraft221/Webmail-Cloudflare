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
  it("refuses production without ADDRESS_HEADER=cf-connecting-ip", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(
      /ADDRESS_HEADER/,
    );
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: "production",
        ADDRESS_HEADER: "x-forwarded-for",
      }),
    ).toThrow();
    expect(
      loadConfig({
        ...base,
        NODE_ENV: "production",
        ADDRESS_HEADER: "CF-Connecting-IP",
      }).production,
    ).toBe(true);
  });
  it("allows the socket address outside production", () => {
    expect(loadConfig(base).production).toBe(false);
  });
  it("refuses a missing value, a short key and plain http to a remote host", () => {
    expect(() => loadConfig({ ...base, INTERNAL_API_TOKEN: "" })).toThrow(
      /INTERNAL_API_TOKEN/,
    );
    expect(() =>
      loadConfig({ ...base, TOTP_ENCRYPTION_KEY: "c2hvcnQ=" }),
    ).toThrow(/32 bytes/);
    expect(() =>
      loadConfig({ ...base, MAIL_API_URL: "http://mail-api.example.test" }),
    ).toThrow(/https/);
    expect(
      loadConfig({ ...base, MAIL_API_URL: "http://127.0.0.1:8790" }).api.apiUrl,
    ).toBe("http://127.0.0.1:8790");
  });
});
