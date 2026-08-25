/**
 * Single source of truth for the integration database.
 *
 * `globalSetup` runs in Vitest's main process, before `test.env` is applied to
 * workers, so both need to read the URL from the same place rather than each
 * assuming the other set it.
 */
export const TEST_DATABASE_URL =
  process.env["AVERIS_TEST_DATABASE_URL"] ??
  "postgresql://averis:averis@localhost:5433/averis_test?schema=public";
