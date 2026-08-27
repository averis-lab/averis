import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnect, prisma, toNumber } from "@averis/db";
import { JobEngine } from "@averis/protocol";
import {
  LedgerSettlementDriver,
  NoSettlementDriver,
  SettlementEngine,
  type SettlementDriver,
  type SettlementInstruction,
} from "@averis/protocol";
import { CreateJobSchema } from "@averis/types";
import {
  resetDatabase,
  seedRegistry,
  startPipeline,
  waitForRewards,
  waitForTerminal,
  type Harness,
} from "./harness";

/**
 * Settlement against a real database.
 *
 * The rules are unit-tested in `tests/settlement.test.ts`; what cannot be
 * tested there is the part that matters most — that a reward is paid exactly
 * once even when two sweeps run at the same time. That property lives entirely
 * in the gap between two database calls, which is where every concurrency bug
 * in this codebase has lived.
 */

const ADDRESSES = { VALIDATOR: "val-wallet", PROTOCOL: "proto-wallet", TREASURY: "treasury-wallet" };
const COHORT = [
  { name: "Markets Agent", domains: ["markets", "geopolitics"] },
  { name: "Research Agent", domains: ["research", "markets"] },
  { name: "Data Quality Agent", domains: ["research", "ai"] },
];

let harness: Harness | null = null;

/** Runs a real job so real rewards exist to settle. */
async function resolvedJob(): Promise<string> {
  harness = startPipeline();
  const jobId = await new JobEngine(harness.ctx).create(
    CreateJobSchema.parse({
      type: "dataset-evaluation",
      query: "Assess whether the curated corpus is reliable enough to act on",
      requiredCapabilities: ["markets", "research"],
      requiredAgents: 3,
      budget: 3,
    }),
  );

  expect(await waitForTerminal(jobId)).toBe("RESOLVED");
  expect(await waitForRewards(jobId)).toBeGreaterThan(0);
  return jobId;
}

/** Gives every agent an owner with a wallet, so agent rewards have a payee. */
async function payAgentsTo(wallet: string): Promise<void> {
  const owner = await prisma.user.create({
    data: { handle: `owner-${wallet}`, walletAddress: wallet },
  });
  await prisma.agent.updateMany({ data: { ownerId: owner.id } });
}

const engineWith = (driver: SettlementDriver) =>
  new SettlementEngine({ driver, addresses: ADDRESSES });

beforeEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
  await resetDatabase();
  await seedRegistry(COHORT);
});

afterAll(async () => {
  if (harness) await harness.stop();
  await disconnect();
});

describe("what settlement refuses", () => {
  it("pays nothing at all under the default driver", async () => {
    const jobId = await resolvedJob();
    await payAgentsTo("agent-wallet");

    const report = await engineWith(new NoSettlementDriver()).sweep(50, jobId);

    expect(report.settled).toEqual([]);
    expect(report.failed.length).toBeGreaterThan(0);
    // The rewards are still owed, which is the point: a driver that cannot pay
    // must not leave rows marked as paid.
    const pending = await prisma.reward.count({ where: { jobId, status: "PENDING" } });
    expect(pending).toBeGreaterThan(0);
    expect(await prisma.reward.count({ where: { jobId, status: "SETTLED" } })).toBe(0);
  });

  it("skips an agent with no payout address instead of inventing one", async () => {
    const jobId = await resolvedJob();

    const plan = await engineWith(new LedgerSettlementDriver()).plan(50, jobId);
    const agentSkips = plan.skips.filter((s) => s.reason.includes("no payout address"));

    expect(agentSkips.length).toBeGreaterThan(0);
    // The protocol's own shares still resolve from the address book.
    expect(plan.instructions.length).toBeGreaterThan(0);
  });

  it("holds a whole job whose rewards exceed its budget", async () => {
    const jobId = await resolvedJob();
    await payAgentsTo("agent-wallet");

    // Simulates a bad split reaching the point of no return.
    const first = await prisma.reward.findFirstOrThrow({ where: { jobId } });
    await prisma.reward.update({ where: { id: first.id }, data: { amount: "999.000000" } });

    const plan = await engineWith(new LedgerSettlementDriver()).plan(50, jobId);

    expect(plan.instructions).toEqual([]);
    expect(plan.skips.every((s) => s.reason.includes("more than its budget"))).toBe(true);
  });
});

describe("paying", () => {
  it("settles every payable reward exactly once and records each payment", async () => {
    const jobId = await resolvedJob();
    await payAgentsTo("agent-wallet");

    const report = await engineWith(new LedgerSettlementDriver()).sweep(50, jobId);

    expect(report.failed).toEqual([]);
    expect(report.settled.length).toBeGreaterThan(0);

    const rewards = await prisma.reward.findMany({
      where: { jobId },
      include: { transaction: true },
    });

    for (const reward of rewards.filter((r) => r.status === "SETTLED")) {
      expect(reward.settledAt).not.toBeNull();
      expect(reward.transaction?.status).toBe("CONFIRMED");
      expect(reward.transaction?.signature).toBe(`ledger:${reward.id}`);
      expect(reward.transaction?.chain).toBe("ledger");
    }

    // Never more transactions than rewards: one payment per debt.
    const transactions = await prisma.transaction.count();
    expect(transactions).toBe(report.settled.length);
  });

  it("does not pay twice when two sweeps run at once", async () => {
    const jobId = await resolvedJob();
    await payAgentsTo("agent-wallet");

    const payable = (await engineWith(new LedgerSettlementDriver()).plan(50, jobId)).instructions
      .length;
    expect(payable).toBeGreaterThan(1);

    // Both sweeps see the same PENDING rows and race for them.
    const [a, b] = await Promise.all([
      engineWith(new LedgerSettlementDriver()).sweep(50, jobId),
      engineWith(new LedgerSettlementDriver()).sweep(50, jobId),
    ]);

    const settledIds = [...a.settled, ...b.settled].map((s) => s.rewardId);
    expect(new Set(settledIds).size).toBe(settledIds.length);
    expect(settledIds).toHaveLength(payable);

    // The database is the real check: one transaction per reward, no doubles.
    const rows = await prisma.reward.findMany({ where: { jobId }, include: { transaction: true } });
    const withTransactions = rows.filter((r) => r.transaction !== null);
    expect(withTransactions).toHaveLength(payable);
    expect(await prisma.transaction.count()).toBe(payable);
  });

  it("is idempotent when the same sweep is run again", async () => {
    const jobId = await resolvedJob();
    await payAgentsTo("agent-wallet");

    const first = await engineWith(new LedgerSettlementDriver()).sweep(50, jobId);
    const second = await engineWith(new LedgerSettlementDriver()).sweep(50, jobId);

    expect(second.settled).toEqual([]);
    expect(await prisma.transaction.count()).toBe(first.settled.length);
  });

  it("returns a reward to PENDING when the driver fails, and records the attempt", async () => {
    const jobId = await resolvedJob();
    await payAgentsTo("agent-wallet");

    const broken: SettlementDriver = {
      name: "broken",
      settle: async (_instruction: SettlementInstruction) => {
        throw new Error("network unreachable");
      },
    };

    const report = await engineWith(broken).sweep(50, jobId);

    expect(report.settled).toEqual([]);
    expect(report.failed.length).toBeGreaterThan(0);
    expect(report.failed[0]!.error).toContain("network unreachable");

    const reward = await prisma.reward.findUniqueOrThrow({
      where: { id: report.failed[0]!.rewardId },
      include: { transaction: true },
    });

    // Owed again, so a later sweep retries it — with the failure preserved.
    expect(reward.status).toBe("PENDING");
    expect(reward.transaction?.status).toBe("FAILED");
    expect(reward.transaction?.error).toContain("network unreachable");
  });

  it("never pays out more than the job's budget", async () => {
    const jobId = await resolvedJob();
    await payAgentsTo("agent-wallet");

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    const report = await engineWith(new LedgerSettlementDriver()).sweep(50, jobId);
    const paid = report.settled.reduce((sum, row) => sum + row.amount, 0);

    expect(paid).toBeLessThanOrEqual(toNumber(job.budget) + 1e-6);
  });
});
