import { prisma, toNumber, toDecimalInput } from "@averis/db";
import type { SpendLedger, SpendRecord, SpendWindowQuery } from "@averis/budget";

/**
 * Postgres-backed spend ledger.
 *
 * `withLock` uses a Postgres advisory lock rather than the guard's in-process
 * mutex, because in production several worker processes contend for the same
 * operator's budget and an in-process lock would not see the others at all.
 */
export class PrismaSpendLedger implements SpendLedger {
  async committed(query: SpendWindowQuery): Promise<number> {
    const rows = await prisma.budgetSpend.findMany({
      where: {
        createdAt: { gte: query.since },
        ...(query.operatorId !== undefined ? { operatorId: query.operatorId } : {}),
        ...(query.jobId ? { jobId: query.jobId } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.agentId
          ? { detail: { path: ["agentId"], equals: query.agentId } }
          : {}),
      },
      select: { reserved: true, actual: true },
    });

    // Counts `actual ?? reserved`: an unreconciled reservation is money
    // already spoken for, and ignoring it is how concurrent work overruns.
    return rows.reduce(
      (acc, row) => acc + (row.actual !== null ? toNumber(row.actual) : toNumber(row.reserved)),
      0,
    );
  }

  async reserve(
    record: Omit<SpendRecord, "id" | "createdAt" | "settledAt" | "actual">,
  ): Promise<SpendRecord> {
    const row = await prisma.budgetSpend.create({
      data: {
        operatorId: record.operatorId,
        jobId: record.jobId,
        category: record.category,
        reserved: toDecimalInput(record.reserved),
        detail: record.agentId ? { agentId: record.agentId } : {},
      },
    });

    return {
      id: row.id,
      operatorId: row.operatorId,
      jobId: row.jobId,
      agentId: record.agentId,
      category: record.category,
      reserved: toNumber(row.reserved),
      actual: null,
      createdAt: row.createdAt,
      settledAt: null,
    };
  }

  async reconcile(id: string, actualUsd: number): Promise<void> {
    await prisma.budgetSpend.update({
      where: { id },
      data: { actual: toDecimalInput(actualUsd), settledAt: new Date() },
    });
  }

  async release(id: string): Promise<void> {
    await prisma.budgetSpend.delete({ where: { id } }).catch(() => undefined);
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Advisory locks take a bigint; hash the key into one deterministically.
    const lockId = hashToBigInt(key);
    return prisma.$transaction(async (tx) => {
      // `$executeRaw`, not `$queryRaw`: pg_advisory_xact_lock returns void,
      // which has no Prisma column type to deserialize into. The lock is held
      // until the surrounding transaction ends, so nothing needs unlocking.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId}::bigint)`;
      return fn();
    });
  }
}

function hashToBigInt(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // Postgres advisory locks use a signed 64-bit integer.
  return BigInt.asIntN(64, hash);
}
