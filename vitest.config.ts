import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests cover subdomain mode; the shipped config defaults to path mode.
        miniflare: { bindings: { TEST_MIGRATIONS: migrations, PAD_DOMAIN: "scrawls.dev" } },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
