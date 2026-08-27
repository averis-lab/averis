import { prisma } from "@averis/db";
import {
  OracleUnavailableError,
  brierScore,
  evaluateCriteria,
  type PendingPrediction,
  type ResolutionOracle,
} from "@averis/types";
import type { ProtocolContext } from "./context";
import { optionalOracles } from "./oracles";

/**
 * Resolves predictions whose deadline has passed.
 *
 * This is the loop that makes reputation mean something. Everything else in
 * the protocol scores an agent on how its work *looks*; only this scores it on
 * whether the agent was actually right. Without it, accuracy and calibration
 * would be unfalsifiable.
 */
export class ResolutionStage {
  private readonly oracles: ResolutionOracle[];

  constructor(
    private readonly ctx: ProtocolContext,
    oracles: ResolutionOracle[] = [],
  ) {
    this.oracles = oracles;
  }

  async run(
    now: Date = new Date(),
  ): Promise<{ resolved: number; unresolvable: number; deferred: number }> {
    const due = await prisma.prediction.findMany({
      where: { outcome: "PENDING", deadline: { lte: now } },
      include: { claim: { include: { output: { select: { agentId: true } } } } },
      take: 200,
    });

    let resolved = 0;
    let unresolvable = 0;
    /** Left PENDING because the oracle was unreachable, not because it said no. */
    let deferred = 0;

    for (const row of due) {
      const criteria = row.criteria as PendingPrediction["criteria"];
      const prediction: PendingPrediction = {
        id: row.id,
        claimId: row.claimId,
        agentId: row.claim.output.agentId,
        statement: row.statement,
        confidence: row.confidence,
        criteria,
        deadline: row.deadline,
      };

      const oracle = this.oracles.find((o) => o.supports(criteria.source ?? ""));

      if (!oracle) {
        // No oracle can answer, so the prediction is voided rather than
        // guessed. Scoring an unverifiable claim either way would corrupt the
        // agent's accuracy with noise.
        await this.record(row.id, "UNRESOLVABLE", null, "no oracle supports this source", null);
        unresolvable++;
        continue;
      }

      try {
        const observed = await oracle.observe(prediction, now);
        if (observed === null) {
          await this.record(row.id, "UNRESOLVABLE", null, `oracle:${oracle.name}`, null);
          unresolvable++;
          continue;
        }

        const wasTrue = evaluateCriteria(criteria.operator, observed, criteria.threshold);
        await this.record(
          row.id,
          wasTrue ? "TRUE" : "FALSE",
          observed,
          `oracle:${oracle.name}`,
          brierScore(row.confidence, wasTrue),
        );
        resolved++;
      } catch (error) {
        if (error instanceof OracleUnavailableError) {
          // Nothing is written: the row stays PENDING and the next sweep tries
          // again. It settles as UNRESOLVABLE only once the oracle declines on
          // its own terms — which it will, once the deadline is far enough
          // behind that a spot reading could not describe it anyway.
          this.ctx.logger.warn("prediction deferred; oracle unreachable", {
            predictionId: row.id,
            oracle: oracle.name,
            error: error.message,
          });
          deferred++;
          continue;
        }

        this.ctx.logger.warn("prediction resolution failed", {
          predictionId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.record(row.id, "UNRESOLVABLE", null, `oracle:${oracle.name}:error`, null);
        unresolvable++;
      }
    }

    return { resolved, unresolvable, deferred };
  }

  private async record(
    predictionId: string,
    outcome: "TRUE" | "FALSE" | "UNRESOLVABLE",
    observedValue: number | string | null,
    resolvedBy: string,
    brier: number | null,
  ): Promise<void> {
    await prisma.$transaction([
      prisma.prediction.update({ where: { id: predictionId }, data: { outcome } }),
      prisma.predictionResolution.create({
        data: {
          predictionId,
          outcome,
          observedValue: observedValue === null ? undefined : { value: observedValue },
          resolvedBy,
          brierScore: brier,
        },
      }),
    ]);
  }
}

/**
 * Resolves predictions against the upstream data network's own curation state
 * at epoch close.
 *
 * Included because it is the one oracle this protocol can implement honestly
 * today: it reads a number the data network publishes, rather than asserting
 * a price or an outcome it has no authority over. Price and on-chain oracles
 * plug in the same way.
 */
export class CurationOracle implements ResolutionOracle {
  readonly name = "reppo-curation";

  constructor(private readonly ctx: ProtocolContext) {}

  supports(source: string): boolean {
    return source.startsWith("reppo:");
  }

  async observe(prediction: PendingPrediction): Promise<number | null> {
    const jobDatanets = await prisma.job.findFirst({
      where: { outputs: { some: { claims: { some: { id: prediction.claimId } } } } },
      select: { datanetIds: true },
    });

    const ids = jobDatanets?.datanetIds ?? [];
    if (ids.length === 0) return null;

    const datanets = await Promise.all(ids.map((id) => this.ctx.data.getDatanet(id)));
    const present = datanets.filter((d): d is NonNullable<typeof d> => d !== null);
    if (present.length === 0) return null;

    if (prediction.criteria.metric === "corpus_approval_rate") {
      const up = present.reduce((acc, d) => acc + d.curation.upVoteVolume, 0);
      const down = present.reduce((acc, d) => acc + d.curation.downVoteVolume, 0);
      return up + down > 0 ? up / (up + down) : null;
    }

    return null;
  }
}

/**
 * Every oracle this deployment can answer with.
 *
 * One function, called by both the resolution worker and the `resolve` script,
 * so an operator inspecting a sweep by hand sees exactly the set production
 * runs. A tool that assembled its own list would be verifying a configuration
 * nothing else uses, which is the specific way a check like that stops being
 * worth anything.
 */
export function createOracles(ctx: ProtocolContext): ResolutionOracle[] {
  // Curation needs no configuration: it reads the data network the protocol
  // already talks to.
  return [new CurationOracle(ctx), ...optionalOracles(ctx.env, ctx.logger)];
}
