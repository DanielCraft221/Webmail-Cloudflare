import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { FAKE } from "../test/fake-tokens.ts";

/** Runs after the http project (playwright.config.ts): passwords, codes and tokens it typed. */
test("the app log has no password, code, token, cookie or Authorization", () => {
  const log = readFileSync("test-results/app.log", "utf8");
  expect(existsSync("test-results/secrets.txt")).toBe(true);
  const secrets = readFileSync("test-results/secrets.txt", "utf8")
    .split("\n")
    .filter((s) => s.length >= 6);
  expect(secrets.length).toBeGreaterThan(20);
  for (const secret of secrets)
    expect(log, "a secret reached the log").not.toContain(secret);
  for (const word of [
    FAKE.internalToken,
    FAKE.accessSecret,
    "Bearer",
    "Authorization",
    "webmail_session=",
  ])
    expect(log).not.toContain(word);
  expect(log).not.toContain(Buffer.alloc(32, 9).toString("base64"));
});
