import { prisma, toDecimalInput, toNumber } from "@averis/db";
import type { ExitReason as PrismaExitReason } from "@averis/db";
import { DriverRefusedError, type TradeDriver } from "./drivers";
import {
  deriveBreaker,
  planEntry,
  planExit,
  type ClosedTrade,
  type EntryDecision,
  type IntelligenceVerdict,
  type OpenPosition,
} from "./plan";
import { parseStoredPolicy } from "./policy";
import type { PriceSource } from "./prices";

/**
 * The automation runtime.
 *
 * This is the half that touches the database, kept apart from `plan.ts` the
 * same way `settlement.ts` is kept apart from `settlement-plan.ts`. Every rule
 * that decides whether a position opens lives over there and can be tested
 * without Postgres; everything here is loading, persisting and ordering.
 *
 * It reads finished jobs and never writes one. The protocol does not know this
 * class exists.
 */

/** How far back the breaker and the cooldowns look. */
const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface EvaluateResult {
  decision: EntryDecision;
  positionId: string | null;
}

export class AutomationEngine {
  constructor(
    private readonly driver: TradeDriver,
    private readonly prices: PriceSource,
  ) {}

  /**
   * Builds the verdict an entry gate reads from a job the protocol resolved.
   *
   * Returns null for anything unresolved. A job that failed its own
   * `minimumConfidence` was intelligence the protocol declined to stand behind,
   * and an automation must not be the one component willing to act on it.
   */
  async verdictFor(jobId: string): Promise<IntelligenceVerdict | null> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { consensus: true, outputs: { select: { id: true } } },
    });

    if (!job || job.status !== "RESOLVED" || !job.consensus) return null;
    if (!job.target) return null;

    const consensus = job.consensus;
    const claims = Array.isArray(consensus.claims)
      ? (consensus.claims as Array<{ supportingEvidence?: unknown[] }>)
      : [];
    const disagreements = Array.isArray(consensus.disagreements)
      ? consensus.disagreements.length
      : 0;
    const recommendation = (consensus.recommendation ?? null) as { action?: string } | null;
    const metadata = (job.metadata ?? {}) as { symbol?: string };

    return {
      jobId: job.id,
      token: job.target,
      symbol: metadata.symbol ?? job.target.slice(0, 6),
      action: recommendation?.action ?? "",
      confidence: consensus.confidence,
      consensus: consensus.consensusScore,
      // Agents that actually finished, not the cohort that was requested.
      agentsReporting: job.outputs.length,
      unsupportedClaims: claims.filter((c) => (c.supportingEvidence?.length ?? 0) === 0).length,
      disagreements,
    };
  }

  /**
   * Runs one job past one automation's policy, and opens a position if it
   * clears every gate.
   *
   * The refusal path writes an event too. "Why did nothing trade today" is the
   * question an operator actually asks, and it cannot be answered from a table
   * that only remembers the trades that happened.
   */
  async evaluate(automationId: string, jobId: string, now = new Date()): Promise<EvaluateResult> {
    const automation = await prisma.automation.findUnique({ where: { id: automationId } });
    if (!automation) throw new Error(`Automation ${automationId} not found`);

    const policy = parseStoredPolicy(automation.policy);
    const verdict = await this.verdictFor(jobId);
    if (!verdict) {
      const decision: EntryDecision = {
        open: false,
        reason: "NOT_A_BUY",
        message: "Job is not resolved, carries no consensus, or names no target token",
        sizeUsd: 0,
        gates: [],
      };
      await this.record(automationId, "REFUSED", "UNRESOLVED", decision.message, jobId);
      return { decision, positionId: null };
    }

    const [openPositions, recentTrades] = await Promise.all([
      this.openPositions(automationId),
      this.recentTrades(automationId, now),
    ]);

    const decision = planEntry({
      verdict,
      policy,
      active: automation.active,
      openPositions,
      recentTrades,
      breakerResetAt: automation.breakerResetAt,
      now,
    });

    if (!decision.open) {
      await this.record(automationId, "REFUSED", decision.reason, decision.message, jobId, {
        gates: decision.gates,
      });
      return { decision, positionId: null };
    }

    // The mark is fetched only after the gates pass, so a quote failure cannot
    // be mistaken for a policy refusal in the event log.
    const price = await this.prices.quote(verdict.token);
    if (price === null) {
      const message = `No price available for ${verdict.symbol} from source "${this.prices.name}"`;
      await this.record(automationId, "REFUSED", "NO_PRICE", message, jobId);
      return { decision: { ...decision, open: false, message }, positionId: null };
    }

    if (automation.mode === "LIVE" && !this.driver.spendsRealMoney) {
      const message = `Automation is in LIVE mode but driver "${this.driver.name}" cannot spend. Refusing rather than booking a paper fill against a live book.`;
      await this.record(automationId, "REFUSED", "NO_LIVE_DRIVER", message, jobId);
      return { decision: { ...decision, open: false, message }, positionId: null };
    }

    let fill;
    try {
      fill = await this.driver.open({
        token: verdict.token,
        symbol: verdict.symbol,
        sizeUsd: decision.sizeUsd,
        price,
      });
    } catch (error) {
      const message =
        error instanceof DriverRefusedError ? error.message : `Driver failed: ${String(error)}`;
      await this.record(automationId, "REFUSED", "DRIVER_REFUSED", message, jobId);
      return { decision: { ...decision, open: false, message }, positionId: null };
    }

    try {
      const position = await prisma.position.create({
        data: {
          automationId,
          jobId: verdict.jobId,
          token: verdict.token,
          symbol: verdict.symbol,
          sizeUsd: toDecimalInput(decision.sizeUsd),
          entryPrice: toDecimalInput(fill.price),
          peakPrice: toDecimalInput(fill.price),
          confidence: verdict.confidence,
          consensus: verdict.consensus,
          agentsReporting: verdict.agentsReporting,
          openedAt: now,
        },
      });

      await this.record(automationId, "OPENED", null, decision.message, jobId, {
        positionId: position.id,
        price: fill.price,
        sizeUsd: decision.sizeUsd,
        driver: this.driver.name,
      });

      return { decision, positionId: position.id };
    } catch (error) {
      // `Position.jobId` is unique, so a redelivered evaluation loses the race
      // rather than opening a second position on the same verdict. Queues
      // deliver at least once; that is normal here, not exceptional.
      if (isUniqueViolation(error)) {
        const existing = await prisma.position.findUnique({ where: { jobId: verdict.jobId } });
        return { decision, positionId: existing?.id ?? null };
      }
      throw error;
    }
  }

  /**
   * Marks every open position and closes the ones whose exit rules fired.
   *
   * Runs regardless of whether the automation is started. Stopping gates new
   * entries only — walking away from risk already on the book is worse than
   * continuing to manage it.
   */
  async sweepExits(
    automationId: string,
    now = new Date(),
  ): Promise<{ checked: number; closed: number; unpriced: number }> {
    const automation = await prisma.automation.findUnique({ where: { id: automationId } });
    if (!automation) throw new Error(`Automation ${automationId} not found`);

    const policy = parseStoredPolicy(automation.policy);
    const positions = await prisma.position.findMany({
      where: { automationId, status: "OPEN" },
    });

    let closed = 0;
    let unpriced = 0;

    for (const row of positions) {
      const price = await this.prices.quote(row.token);
      if (price === null) {
        unpriced++;
        continue;
      }

      const position: OpenPosition = {
        id: row.id,
        token: row.token,
        sizeUsd: toNumber(row.sizeUsd),
        entryPrice: toNumber(row.entryPrice),
        peakPrice: toNumber(row.peakPrice),
        openedAt: row.openedAt,
      };

      const exit = planExit(position, price, policy, now);

      if (!exit.close) {
        // The peak is persisted on every mark, not only on exit: a trailing
        // stop that recomputed its reference from stored marks would forget
        // any high it did not happen to close on.
        if (exit.peakPrice > position.peakPrice) {
          await prisma.position.update({
            where: { id: row.id },
            data: { peakPrice: toDecimalInput(exit.peakPrice) },
          });
        }
        continue;
      }

      await this.close(row.id, price, exit.reason as PrismaExitReason, exit.message, now);
      closed++;
    }

    // Recording the breaker after the sweep means the operator sees it trip on
    // the same tick the losing trade closed, rather than one tick later.
    const trades = await this.recentTrades(automationId, now);
    const breaker = deriveBreaker(trades, policy, automation.breakerResetAt, now);
    if (breaker.paused) {
      await this.record(automationId, "BREAKER", "TRIPPED", breaker.reason ?? "tripped", null, {
        consecutiveLosses: breaker.consecutiveLosses,
        dailyPnlUsd: breaker.dailyPnlUsd,
      });
    }

    return { checked: positions.length, closed, unpriced };
  }

  /** Closes one position at a mark. Used by the sweep and by a manual close. */
  async close(
    positionId: string,
    price: number,
    reason: PrismaExitReason,
    message: string,
    now = new Date(),
  ): Promise<void> {
    // Conditional on still being OPEN, so two sweeps racing cannot both book
    // an exit for the same position — the same shape as claiming a reward.
    const row = await prisma.position.findUnique({ where: { id: positionId } });
    if (!row || row.status !== "OPEN") return;

    const entryPrice = toNumber(row.entryPrice);
    const sizeUsd = toNumber(row.sizeUsd);
    const pnlUsd = sizeUsd * ((price - entryPrice) / entryPrice);

    const updated = await prisma.position.updateMany({
      where: { id: positionId, status: "OPEN" },
      data: {
        status: "CLOSED",
        exitPrice: toDecimalInput(price),
        pnlUsd: toDecimalInput(pnlUsd),
        exitReason: reason,
        closedAt: now,
      },
    });
    if (updated.count === 0) return;

    await this.record(row.automationId, "CLOSED", reason, message, row.jobId, {
      positionId,
      price,
      pnlUsd,
    });
  }

  private async openPositions(automationId: string): Promise<OpenPosition[]> {
    const rows = await prisma.position.findMany({ where: { automationId, status: "OPEN" } });
    return rows.map((row) => ({
      id: row.id,
      token: row.token,
      sizeUsd: toNumber(row.sizeUsd),
      entryPrice: toNumber(row.entryPrice),
      peakPrice: toNumber(row.peakPrice),
      openedAt: row.openedAt,
    }));
  }

  private async recentTrades(automationId: string, now: Date): Promise<ClosedTrade[]> {
    const rows = await prisma.position.findMany({
      where: {
        automationId,
        status: "CLOSED",
        closedAt: { gte: new Date(now.getTime() - HISTORY_WINDOW_MS) },
      },
      select: { token: true, pnlUsd: true, closedAt: true },
    });
    return rows.flatMap((row) =>
      row.closedAt ? [{ token: row.token, pnlUsd: toNumber(row.pnlUsd), closedAt: row.closedAt }] : [],
    );
  }

  private async record(
    automationId: string,
    kind: string,
    reason: string | null,
    message: string,
    jobId: string | null,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await prisma.automationEvent.create({
      data: { automationId, kind, reason, message, jobId, detail: detail as object },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}
