import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./config";

/**
 * Provisions a dedicated `averis_test` database before the suite runs.
 *
 * Integration tests truncate between cases, so they must never point at the
 * development database. Creating a separate one is the only way to keep that
 * guarantee cheap and obvious.
 *
 * The schema is applied with `prisma migrate deploy`, not `db push`. Two
 * reasons, and the second is why it changed:
 *
 *  1. It exercises the same migrations a release runs. A suite that pushed the
 *     schema directly would pass against a shape production never builds, and
 *     a broken migration would first be discovered on deploy.
 *  2. `db push` compares against whatever the database already holds, so a
 *     schema change that tightens a constraint makes it demand
 *     `--accept-data-loss` on the second run. Passing that flag in a test
 *     harness would mean the one place that shouts about destructive schema
 *     changes had been permanently silenced.
 *
 * The database is dropped and rebuilt each run. It holds nothing worth keeping
 * — the suite truncates between cases anyway — and rebuilding removes every
 * question about drift from a previous schema.
 */
export async function setup(): Promise<void> {
  const url = TEST_DATABASE_URL;

  if (!url.includes("averis_test")) {
    throw new Error(
      `Refusing to run integration tests against "${url}" — they truncate tables, ` +
        "so the target database name must contain averis_test.",
    );
  }

  const container = process.env["AVERIS_TEST_PG_CONTAINER"] ?? "averis-postgres";

  try {
    execSync(
      `docker exec ${container} psql -U averis -d postgres -c ` +
        `"DROP DATABASE IF EXISTS averis_test WITH (FORCE)" -c "CREATE DATABASE averis_test"`,
      { stdio: "pipe", shell: "/bin/bash" },
    );
  } catch (error) {
    throw new Error(
      "Could not reach Postgres to create the test database. Run `npm run infra:up` first.\n" +
        String(error),
    );
  }

  // Both variables are set because `prisma.config.ts` prefers
  // DIRECT_DATABASE_URL — it is what a pooled deployment migrates through, and
  // leaving it pointed at the development database here would apply the
  // migrations to the wrong one.
  try {
    execSync("npx prisma migrate deploy", {
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    });
  } catch (error) {
    const detail = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    throw new Error(`Could not migrate the test database:\n${detail}`);
  }
}
