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
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
