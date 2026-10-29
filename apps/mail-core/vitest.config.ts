import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs in Node from this package folder, so "migrations" resolves next to this file.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("migrations"),
          // Fake values for tests only. Production sets these in Etapa 3 PR 2.
          ACCESS_TEAM_DOMAIN: "https://webmail-test.cloudflareaccess.com",
          ACCESS_AUD: "test-aud",
          ACCESS_CLIENT_ID: "test-client.access",
          INTERNAL_API_TOKEN: "test-bearer",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
