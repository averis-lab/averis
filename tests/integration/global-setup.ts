import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./config";

/**
 * Provisions a dedicated `averis_test` database before the suite runs.
 *
 * Integration tests truncate between cases, so they must never point at the
 * development database. Creating a separate one is the only way to keep that
 * guarantee cheap and obvious.
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
    // Idempotent: a second run finds the database already there.
    execSync(
      `docker exec ${container} psql -U averis -d postgres -tc ` +
        `"SELECT 1 FROM pg_database WHERE datname='averis_test'" | grep -q 1 || ` +
        `docker exec ${container} createdb -U averis averis_test`,
      { stdio: "pipe", shell: "/bin/bash" },
    );
  } catch (error) {
    throw new Error(
      "Could not reach Postgres to create the test database. Run `npm run infra:up` first.\n" +
        String(error),
    );
  }

  // Bring the test database up to the current schema.
  //
  // `--url` rather than a DATABASE_URL override: Prisma 7 reads the datasource
  // from prisma.config.ts, so the environment variable alone would push to the
  // development database instead.
  //
  // No `--accept-data-loss`: this database is created empty, so there is
  // nothing to lose, and a push that *would* destroy data should fail loudly
  // rather than be waved through.
  try {
    execSync(`npx prisma db push --url "${url}"`, { stdio: "pipe" });
  } catch (error) {
    const detail = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    throw new Error(`Could not push the schema to the test database:\n${detail}`);
  }
}
