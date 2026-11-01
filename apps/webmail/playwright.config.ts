import { defineConfig, devices } from "@playwright/test";
import { FAKE } from "./test/fake-tokens.ts";

export const APP_PORT = 4173;
const API_PORT = 8790;

/**
 * Runs against the production build (`pnpm test:http` builds it with ORIGIN set), as CSRF and
 * __Host- cookies only behave for real there. The API is the fake Worker; secrets are fake.
 */
// No NODE_ENV on purpose: every build is production (config.ts), whatever NODE_ENV says.
export const APP_ENV = {
  ADDRESS_HEADER: "cf-connecting-ip",
  HOST: "127.0.0.1",
  PORT: String(APP_PORT),
  MAIL_API_URL: `http://127.0.0.1:${API_PORT}`,
  INTERNAL_API_TOKEN: FAKE.internalToken,
  CF_ACCESS_CLIENT_ID: FAKE.accessId,
  CF_ACCESS_CLIENT_SECRET: FAKE.accessSecret,
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  WEBMAIL_DB_PATH: "test-results/e2e.db",
};

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/output",
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: "list",
  use: { baseURL: `http://localhost:${APP_PORT}` },
  webServer: [
    {
      command: "node test/fake-worker.ts",
      url: `http://127.0.0.1:${API_PORT}/health`,
      env: { PORT: String(API_PORT) },
      reuseExistingServer: false,
    },
    {
      // A fresh SQLite each run; the log is read by e2e/logs.spec.ts. test-results/ is
      // git-ignored, so a fresh checkout (CI) does not have it until mkdir.
      command:
        "mkdir -p test-results && rm -f test-results/e2e.db* test-results/secrets.txt && node build > test-results/app.log 2>&1",
      // 400: no CF-Connecting-IP on the readiness probe, which is the expected answer.
      url: `http://127.0.0.1:${APP_PORT}/login`,
      env: APP_ENV,
      reuseExistingServer: false,
    },
  ],
  projects: [
    { name: "http", testMatch: "http/*.spec.ts" },
    { name: "logs", testMatch: "logs.spec.ts", dependencies: ["http"] },
    {
      name: "firefox",
      testMatch: "browser/*.spec.ts",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
