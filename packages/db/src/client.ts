import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client";

/**
 * Prisma 7 requires an explicit driver adapter; the connection string no
 * longer lives in schema.prisma. Constructing it here means every service
 * (api, workers, operator) shares one pool configuration.
 */
function create(): PrismaClient {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, then run `npm run infra:up`.",
    );
  }
  const adapter = new PrismaPg({ connectionString });
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
