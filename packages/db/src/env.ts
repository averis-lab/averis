import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Loads the monorepo's root `.env`, wherever the process was started from.
 *
 * `import "dotenv/config"` resolves `.env` against the current working
 * directory, and npm runs a workspace script with the cwd set to that
 * workspace — so `npm run dev:api` looked for `apps/api/.env`, found nothing,
 * and the service died on a missing DATABASE_URL. Walking up from this
 * module's own location finds the real file regardless of cwd.
 *
 * Import this before anything that reads `process.env` at module scope.
 */
function findRootEnv(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const envPath = findRootEnv();
// A real environment (Docker, CI, a platform) sets variables directly and has
// no .env file; that is not an error.
config(envPath ? { path: envPath } : { path: undefined });

export const loadedEnvPath = envPath ?? null;
