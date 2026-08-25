import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { TEST_DATABASE_URL } from "./tests/integration/config.ts";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Lifecycle tests: real Postgres, everything else deterministic.
 *
 * Kept out of the default `vitest.config.ts` so `npm test` stays infra-free and
 * fast. These need `npm run infra:up` and run against a dedicated database.
 */
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/integration/global-setup.ts"],
    // One shared database: files must not race each other.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      QUEUE_DRIVER: "memory",
      REPPO_PROVIDER: "fixture",
      LLM_PROVIDER: "mock",
      LLM_MODEL: "mock-analyst",
      LOG_LEVEL: "silent",
    },
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
    },
  },
});
