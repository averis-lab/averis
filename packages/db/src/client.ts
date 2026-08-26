import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

/**
 * How many real connections one process may hold.
 *
 * The default is the node-postgres default, deliberately: this repository's own
 * workers run several interactive transactions concurrently, and an interactive
 * transaction holds its connection for its whole duration. Capping the pool
 * below that concurrency does not slow things down — it breaks them. A
 * transaction that waits for a free connection longer than Prisma's transaction
 * timeout is rolled back underneath itself, and the error says
 * "Transaction already closed", which points nowhere near the pool.
 *
 * Measured, not assumed: at `max: 5` the integration suite failed on roughly
 * one run in three, at `max: 20` it did not.
 *
 * Lowering it is still the right move on a pooled provider — Supabase's
 * connection budget is shared by the API, every worker and the operator — but
 * it is a number to derive from process count, not to default to. Count the
 * processes, divide the budget, leave headroom for migrations and psql.
 */
const DEFAULT_POOL_MAX = 10;

function poolMax(): number {
  const raw = Number(process.env["DATABASE_POOL_MAX"]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_POOL_MAX;
}

/**
 * Prisma 7 requires an explicit driver adapter; the connection string no
 * longer lives in schema.prisma. Constructing it here means every service
 * (api, workers, operator) shares one pool configuration.
 *
 * This reads `DATABASE_URL` and never `DIRECT_DATABASE_URL`. The split is the
 * point: the app wants the pooler because it opens many short queries, and
 * migrations want a direct session because a transaction-mode pooler can hand
 * consecutive statements to different backends. `prisma.config.ts` is where the
 * other half of that decision lives.
 */
function create(): PrismaClient {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, then run `npm run infra:up`.",
    );
  }
  const adapter = new PrismaPg({
    connectionString,
    max: poolMax(),
    // A pooled connection that is idle is still one nobody else can use.
    idleTimeoutMillis: 10_000,
    /**
     * Shorter than Prisma's 5s interactive-transaction timeout, on purpose.
     *
     * When the pool is exhausted something has to give first, and it should be
     * the connection acquisition — that reports the real problem. If the
     * transaction times out first it is rolled back mid-flight and the error
     * blames the transaction, which is how a pool that is simply too small
     * spends an afternoon looking like a concurrency bug.
     */
    connectionTimeoutMillis: 3_000,
  });
  return new PrismaClient({
    adapter,
    log: process.env["LOG_LEVEL"] === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

// Reuse across hot reloads so dev servers do not exhaust the connection pool.
const globalRef = globalThis as unknown as { __averisPrisma?: PrismaClient };

export const prisma: PrismaClient = globalRef.__averisPrisma ?? create();

if (process.env["NODE_ENV"] !== "production") {
  globalRef.__averisPrisma = prisma;
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

/** Cheap liveness probe used by the API health endpoint. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
