import { prisma, toDecimalInput, toNumber } from "@averis/db";
import type { Logger } from "./context";
import {
  planSettlement,
  type AddressBook,
  type PlannableReward,
  type RewardRole,
  type SettlementDriver,
  type SettlementInstruction,
  type SettlementSkip,
} from "./settlement-plan";

export * from "./settlement-plan";

/**
 * Outbound settlement — the paying half.
 *
 * The rules live in `settlement-plan.ts` and are pure. This file is the part
 * that touches the database and the driver, and its whole job is to make sure
 * a reward is paid at most once: claiming is a conditional update, so two
 * sweeps racing on the same row cannot both win, and `Transaction` holds a
 * unique constraint on `rewardId` so the database refuses a second attempt
 * even if that guard were ever removed.
 */

export interface SettlementOutcome {
  rewardId: string;
  payee: string;
  amount: number;
  reference: string;
  status: "BROADCAST" | "CONFIRMED";
}

export interface SettlementFailure {
  rewardId: string;
  error: string;
}

export interface SettlementReport {
  driver: string;
  settled: SettlementOutcome[];
  failed: SettlementFailure[];
  skipped: SettlementSkip[];
}

export interface SettlementEngineOptions {
  driver: SettlementDriver;
  addresses?: AddressBook;
  logger?: Logger;
}

/**
 * Carries a plan out against the database.
 *
 * Ordering matters more than it looks. The reward is claimed first, the
 * transaction row second, the driver last — so a crash at any point leaves a
 * row that says what was in flight, and never a payment nobody recorded.
 */
export class SettlementEngine {
  private readonly driver: SettlementDriver;
  private readonly addresses: AddressBook;
  private readonly logger: Logger | undefined;

  constructor(options: SettlementEngineOptions) {
    this.driver = options.driver;
    this.addresses = options.addresses ?? {};
    this.logger = options.logger;
  }

  /**
   * What a sweep would do, without doing any of it.
   *
   * Settlement cannot be undone, so the ability to look before paying is not a
   * convenience — it is how an operator checks an address book or a split
   * before it becomes irreversible.
   */
  async plan(limit = 50, jobId?: string) {
    const rows = await prisma.reward.findMany({
      where: { status: "PENDING", ...(jobId ? { jobId } : {}) },
      orderBy: { createdAt: "asc" },
      take: limit,
      include: { agent: { include: { owner: { select: { walletAddress: true } } } } },
    });

    const rewards: PlannableReward[] = rows.map((row) => ({
      id: row.id,
      jobId: row.jobId,
      role: row.role as RewardRole,
      status: row.status,
      amount: toNumber(row.amount),
      currency: row.currency,
      agentId: row.agentId,
      agentPayee: row.agent?.owner?.walletAddress ?? null,
    }));

    const jobIds = [...new Set(rewards.map((reward) => reward.jobId))];
    const jobs = await prisma.job.findMany({
      where: { id: { in: jobIds } },
      select: { id: true, budget: true },
    });
    const budgets = Object.fromEntries(jobs.map((job) => [job.id, toNumber(job.budget)]));

    return planSettlement(rewards, this.addresses, { budgets });
  }

  /** Settles everything outstanding, oldest first. */
  async sweep(limit = 50, jobId?: string): Promise<SettlementReport> {
    const plan = await this.plan(limit, jobId);
    const report: SettlementReport = {
      driver: this.driver.name,
      settled: [],
      failed: [],
      skipped: plan.skips,
    };

    for (const instruction of plan.instructions) {
      const outcome = await this.settleOne(instruction);
      if ("error" in outcome) report.failed.push(outcome);
      else report.settled.push(outcome);
    }

    this.logger?.info("settlement sweep finished", {
      driver: this.driver.name,
      settled: report.settled.length,
      failed: report.failed.length,
      skipped: report.skipped.length,
    });

    return report;
  }

  private async settleOne(
    instruction: SettlementInstruction,
  ): Promise<SettlementOutcome | SettlementFailure> {
    // Conditional claim: whoever flips PENDING → APPROVED owns this reward.
    // A second sweep sees a count of zero and moves on rather than paying it
    // again — the check-then-act window that would otherwise exist here is the
    // same one that made the budget guard overspend.
    const claimed = await prisma.reward.updateMany({
      where: { id: instruction.rewardId, status: "PENDING" },
      data: { status: "APPROVED" },
    });
    if (claimed.count === 0) {
      return { rewardId: instruction.rewardId, error: "claimed by another sweep" };
    }

    let transactionId: string;
    try {
      const transaction = await prisma.transaction.create({
        data: {
          rewardId: instruction.rewardId,
          chain: this.driver.name,
          intent: {
            payee: instruction.payee,
            amount: instruction.amount,
            currency: instruction.currency,
            role: instruction.role,
            jobId: instruction.jobId,
          } as object,
          status: "PENDING",
        },
        select: { id: true },
      });
      transactionId = transaction.id;
    } catch (error) {
      // `rewardId` is unique: an existing row means this reward already has a
      // payment in flight, so the claim is released and nothing is sent.
      await this.release(instruction.rewardId);
      return {
        rewardId: instruction.rewardId,
        error: `a transaction already exists for this reward (${asMessage(error)})`,
      };
    }

    try {
      const receipt = await this.driver.settle(instruction);

      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: transactionId },
          data: {
            signature: receipt.reference,
            status: receipt.status === "CONFIRMED" ? "CONFIRMED" : "BROADCAST",
            simulation: (receipt.detail ?? {}) as object,
          },
        }),
        prisma.reward.update({
          where: { id: instruction.rewardId },
          data: {
            // Only a confirmed payment settles the debt. A broadcast one stays
            // approved until something observes it landing.
            ...(receipt.status === "CONFIRMED"
              ? { status: "SETTLED" as const, settledAt: new Date() }
              : {}),
            amount: toDecimalInput(instruction.amount),
          },
        }),
      ]);

      return {
        rewardId: instruction.rewardId,
        payee: instruction.payee,
        amount: instruction.amount,
        reference: receipt.reference,
        status: receipt.status,
      };
    } catch (error) {
      const message = asMessage(error);
      await prisma.transaction.update({
        where: { id: transactionId },
        data: { status: "FAILED", error: message },
      });
      // Back to PENDING so a later sweep can retry; the failed transaction row
      // stays as the record of the attempt.
      await this.release(instruction.rewardId);
      return { rewardId: instruction.rewardId, error: message };
    }
  }

  private async release(rewardId: string): Promise<void> {
    await prisma.reward.updateMany({
      where: { id: rewardId, status: "APPROVED" },
      data: { status: "PENDING" },
    });
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
