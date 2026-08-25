import { prisma, toNumber } from "@averis/db";
import { BudgetExceededError, BudgetGuard } from "@averis/budget";
import { ExecutionPipeline, type ProtocolContext } from "@averis/protocol";
import { StrategyEngine, type CandidateJob } from "@averis/strategy";
import { PrismaSpendLedger } from "@averis/protocol";
import type { OperatorConfig } from "./config";

export interface TickResult {
  discovered: number;
  accepted: number;
  skipped: Record<string, number>;
  executed: number;
  failed: number;
  budgetBlocked: number;
}

/**
 * An autonomous node.
 *
 * The cycle is deliberately ordered: discover → strategy → budget → execute.
 * Strategy decides what is worth doing, the budget guard decides what can be
 * afforded, and only then does anything run. Neither check happens after
 * execution, because an operator that discovers its costs afterwards is not
 * bounded by anything.
 */
export class Operator {
  private readonly strategy: StrategyEngine;
  private readonly pipeline: ExecutionPipeline;
  private readonly budget: BudgetGuard;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private operatorId: string | null = null;

  constructor(
    private readonly ctx: ProtocolContext,
    private readonly config: OperatorConfig,
  ) {
    this.strategy = new StrategyEngine(config.strategy);
    this.pipeline = new ExecutionPipeline(ctx);
    // The operator enforces its own budget, not the shared default one.
    this.budget = new BudgetGuard(new PrismaSpendLedger(), config.budget);
  }

  /** Registers the operator so its spend is attributable and auditable. */
  async register(): Promise<string> {
    const owner = await prisma.user.upsert({
      where: { handle: "protocol" },
      create: { handle: "protocol" },
      update: {},
      select: { id: true },
    });

    const operator = await prisma.operator.upsert({
      where: { name: this.config.name },
      create: {
        name: this.config.name,
        ownerId: owner.id,
        strategy: this.config.strategy as object,
        budget: this.config.budget as object,
      },
      update: {
        strategy: this.config.strategy as object,
        budget: this.config.budget as object,
      },
      select: { id: true },
    });

    this.operatorId = operator.id;
    return operator.id;
  }

  async start(): Promise<void> {
    await this.register();
    this.ctx.logger.info("operator started", {
      name: this.config.name,
      cadence: this.config.strategy.cadence,
      domains: this.config.strategy.domains,
      dailyBudget: this.config.budget.daily,
    });

    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.ctx.logger.error("operator tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.strategy.cadenceMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One discovery-to-execution cycle. */
  async tick(now: Date = new Date()): Promise<TickResult> {
    const result: TickResult = {
      discovered: 0, accepted: 0, skipped: {}, executed: 0, failed: 0, budgetBlocked: 0,
    };

    const rows = await prisma.job.findMany({
      where: { status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      take: 50,
      select: {
        id: true, type: true, requiredCapabilities: true, budget: true,
        minimumConfidence: true, deadline: true, status: true,
      },
    });

    const candidates: CandidateJob[] = rows
      .filter((row) => !this.inFlight.has(row.id))
      .map((row) => ({
        id: row.id,
        type: row.type,
        requiredCapabilities: row.requiredCapabilities,
        budget: toNumber(row.budget),
        minimumConfidence: row.minimumConfidence,
        deadline: row.deadline,
        status: row.status,
      }));

    result.discovered = candidates.length;
    if (candidates.length === 0) return result;

    const decisions = this.strategy.select(candidates, this.inFlight.size, now);

    for (const decision of decisions) {
      if (!decision.accept) {
        const reason = decision.reason ?? "UNKNOWN";
        result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
        continue;
      }

      const job = candidates.find((c) => c.id === decision.jobId);
      if (!job) continue;

      // Budget is checked before anything runs. A denial is a normal outcome,
      // not an error: the operator simply leaves the job for a later tick or
      // another node.
      try {
        const reservation = await this.budget.reserve(
          {
            operatorId: this.operatorId,
            jobId: job.id,
            category: "llm",
            estimatedUsd: Math.min(job.budget, this.config.budget.perJob),
            detail: { operator: this.config.name, strategyScore: decision.score },
          },
          now,
        );

        result.accepted++;
        this.inFlight.add(job.id);

        try {
          const run = await this.pipeline.runJob(job.id);
          result.executed++;
          // The pipeline reserves per-agent spend of its own; this outer
          // reservation is released so the same work is not counted twice.
          await reservation.release();
          this.ctx.logger.info("operator completed job", { ...run });
        } catch (error) {
          result.failed++;
          await reservation.reconcile(0);
          this.ctx.logger.error("operator job failed", {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.inFlight.delete(job.id);
        }
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          result.budgetBlocked++;
          this.ctx.logger.warn("budget declined a job", {
            jobId: job.id,
            reason: error.decision.reason,
            remaining: error.decision.remaining,
          });
          continue;
        }
        throw error;
      }
    }

    await prisma.operator.update({
      where: { name: this.config.name },
      data: { lastRunAt: new Date() },
    }).catch(() => undefined);

    this.ctx.logger.info("operator tick", { ...result, skipped: JSON.stringify(result.skipped) });
    return result;
  }
}
