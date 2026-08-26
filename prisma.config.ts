import "dotenv/config";
import { defineConfig } from "prisma/config";

/**
 * Configuration for the Prisma **CLI** — migrations, `db push`, Studio, seed.
 *
 * The running services never read this file: `packages/db/src/client.ts` builds
 * its own pool from `DATABASE_URL`. That separation is what lets the two use
 * different connections to the same database, which is exactly what a pooled
 * provider like Supabase requires.
 *
 * Schema changes therefore prefer `DIRECT_DATABASE_URL` when it is set. A
 * transaction-mode pooler may hand consecutive statements to different
 * backends, and a migration does not survive that — it needs one session for
 * its whole run. The app, by contrast, wants the pooler: it opens many short
 * queries and would otherwise burn a real Postgres connection per machine.
 *
 * With no pooler in play (local Docker) `DIRECT_DATABASE_URL` is unset and both
 * fall back to the same string, so nothing about local development changes.
 */
function migrationUrl(): string {
  const direct = process.env["DIRECT_DATABASE_URL"]?.trim();
  const pooled = process.env["DATABASE_URL"]?.trim();
  const url = direct || pooled;
  if (!url) {
    throw new Error(
      "Neither DIRECT_DATABASE_URL nor DATABASE_URL is set. Copy .env.example to .env.",
    );
  }
  return url;
}

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    // Read plainly rather than through `env()`, which throws on a variable that
    // is absent — and `DIRECT_DATABASE_URL` is absent by design whenever there
    // is no pooler to route around.
    url: migrationUrl(),
    /**
     * `migrate dev` needs a scratch database to detect drift, and it creates
     * one by issuing CREATE DATABASE. Hosted Postgres usually refuses that, so
     * point this at a local one — it never holds real data and only has to
     * speak the same Postgres version.
     */
    ...(process.env["SHADOW_DATABASE_URL"]?.trim()
      ? { shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"].trim() }
      : {}),
  },
  migrations: {
    path: "./prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
});
