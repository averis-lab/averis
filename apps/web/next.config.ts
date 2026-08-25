import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

/**
 * Load the monorepo's root `.env`.
 *
 * Next resolves `.env` against this app's own directory, but the stack's
 * configuration lives at the repo root. Without this, `npm run dev` starts the
 * web server with no AVERIS_API_KEY, the server-side proxy sends an empty
 * bearer token, and every API call comes back 401 — while `next start` run by
 * hand from the root works fine, which makes it a confusing failure.
 *
 * Values already present in the environment win, so a real deployment's
 * variables are never overwritten by a stray file.
 */
function loadRootEnv(): void {
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(dir, ".env");
    // Skip this app's own .env — Next already handles that one.
    if (dir !== __dirname && existsSync(candidate)) {
      loadEnv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

loadRootEnv();

const nextConfig: NextConfig = {
  // The landing route is a single-viewport marketing frame; the floating dev
  // badge sits on top of the stats row and reads as part of the design.
  devIndicators: false,
};

export default nextConfig;
