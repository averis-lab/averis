import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    // Lifecycle tests need Postgres and their own database; they run from
    // vitest.integration.config.ts so `npm test` stays infrastructure-free.
    exclude: ["**/node_modules/**", "tests/integration/**"],
    environment: "node",
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@averis/types": pkg("types"),
      "@averis/db": pkg("db"),
      "@averis/queue": pkg("queue"),
      "@averis/reppo-adapter": pkg("reppo-adapter"),
      "@averis/agent-runtime": pkg("agent-runtime"),
      "@averis/consensus": pkg("consensus"),
      "@averis/reputation": pkg("reputation"),
      "@averis/strategy": pkg("strategy"),
      "@averis/budget": pkg("budget"),
      "@averis/execution": pkg("execution"),
      "@averis/protocol": pkg("protocol"),
      "@averis/sdk": pkg("sdk"),
      // The web app's own alias, so its server-side modules can be tested here.
      "@": fileURLToPath(new URL("./apps/web", import.meta.url)),
    },
  },
});
