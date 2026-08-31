import { Prisma, prisma, toNumber } from "@averis/db";
import { QUEUES } from "@averis/queue";
import { extractRubricTerms } from "@averis/reputation";
import type { ConsensusInput, Evidence, Recommendation, Risk } from "@averis/types";
import type { ProtocolContext } from "./context";
import { splitReward } from "./reward-split";
import { JobEngine, JobEngineError } from "./job-engine";

/**
 * Loads a job's submitted outputs in the shape the consensus and evaluation
 * engines consume.
 *
 * Reputation signals are attached here rather than inside the engines, so the
 * engines stay pure functions over their inputs and remain testable without a
 * database.
 */
export async function loadConsensusInputs(jobId: string): Promise<ConsensusInput[]> {
  const [job, outputs] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId }, select: { requiredCapabilities: true } }),
    prisma.agentOutput.findMany({
      where: { jobId },
      include: {
        agent: {
          include: { reputation: { orderBy: { createdAt: "desc" }, take: 30 } },
        },
        claims: {
          orderBy: { position: "asc" },
          include: { evidence: { include: { evidence: true } } },
        },
        evaluations: { where: { evaluatorKind: "deterministic" }, take: 1 },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const domains = job?.requiredCapabilities ?? [];

  return outputs.map((output) => {
    const snapshots = output.agent.reputation;
    const overall = snapshots.find((s) => s.domain === null);
    const domainScores = domains
      .map((domain) => snapshots.find((s) => s.domain === domain))
      .filter((s): s is NonNullable<typeof s> => s !== undefined);

    const domainReputation =
      domainScores.length > 0
        ? domainScores.reduce((acc, s) => acc + s.overall, 0) / domainScores.length
        : 0;

    return {
      outputId: output.id,
      agentId: output.agentId,
      agentName: output.agent.name,
      summary: output.summary,
      confidence: output.confidence,
      // From the output, never from `output.agent`. The registry row carries
      // the agent's *current* binding, and reading the cohort's model mix
      // through it would mean an operator repointing an agent tomorrow
      // silently rewrites what a job finished last week says produced it.
      modelProvider: output.modelProvider,
      modelName: output.modelName,
      claims: output.claims.map((claim) => ({
        statement: claim.statement,
        kind: claim.kind,
        confidence: claim.confidence,
        fingerprint: claim.fingerprint,
        evidence: claim.evidence.map((link): Evidence => ({
          id: link.evidence.id,
          type: link.evidence.type,
          source: link.evidence.source,
          title: link.evidence.title,
          content: link.evidence.content,
          metadata: link.evidence.metadata as Record<string, unknown>,
          reliability: link.evidence.reliability,
          timestamp: link.evidence.retrievedAt,
        })),
      })),
      metrics: output.metrics as Record<string, number | string>,
      recommendation: (output.recommendation as Recommendation | null) ?? null,
      risks: (output.risks as Risk[]) ?? [],
      signals: {
        reputation: overall?.overall ?? 0.5,
        domainReputation,
        accuracy: overall?.accuracy ?? 0.5,
        calibration: overall?.calibration ?? 0.5,
        evidenceQuality: overall?.evidenceQuality ?? 0.5,
        evaluation: output.evaluations[0]?.overall ?? null,
      },
    };
  });
}

/**
 * Scores every submitted output before consensus runs.
 *
 * Evaluation happens first on purpose: the consensus weighting reads each
 * output's evaluation score, so running them the other way round would weight
 * agents using stale information.
 */
export class EvaluationStage {
  private readonly engine: JobEngine;

  constructor(private readonly ctx: ProtocolContext) {
    this.engine = new JobEngine(ctx);
  }

  async run(jobId: string): Promise<number> {
    await this.engine.transition(jobId, "VALIDATING", "scoring agent outputs");

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { datanetIds: true },
    });

    const inputs = await loadConsensusInputs(jobId);
    if (inputs.length === 0 || !job) {
      await this.engine.fail(jobId, "no agent outputs to evaluate");
      return 0;
    }

    // Score against the standards the job's own datanets publish, not a
    // generic yardstick. Falls back to neutral when they publish none.
    // Scoped to the configured source: `externalId` is unique only *within* a
    // data source, so an unqualified lookup would start scoring a job against
    // another network's rubric the moment a second provider exists — and the
    // symptom would be a plausible-looking alignment score, not an error.
    const datanetRows = await prisma.datanet.findMany({
      where: {
        dataSource: { name: this.ctx.data.name },
        externalId: { in: job.datanetIds },
      },
      select: { rubric: true },
    });
    const rubricTerms = extractRubricTerms(
      datanetRows.map((d) => {
        const r = (d.rubric ?? {}) as { publisherSpec?: string; voterRubric?: string };
        return { publisherSpec: r.publisherSpec ?? "", voterRubric: r.voterRubric ?? "" };
      }),
    );

    const scores = this.ctx.evaluation.evaluate(inputs, rubricTerms);

    for (const score of scores) {
      // Prisma cannot address a compound unique key through a NULL column, so
      // the deterministic evaluator's row is located explicitly rather than
      // upserted on (outputId, evaluatorAgentId, evaluatorKind).
      const existing = await prisma.evaluation.findFirst({
        where: { outputId: score.outputId, evaluatorAgentId: null, evaluatorKind: "deterministic" },
        select: { id: true },
      });

      const values = {
        evidenceQuality: score.evidenceQuality,
        internalConsistency: score.internalConsistency,
        specificity: score.specificity,
        corroboration: score.corroboration,
        rubricAlignment: score.rubricAlignment,
        overall: score.overall,
        notes: score.notes as object,
      };

      if (existing) {
        await prisma.evaluation.update({ where: { id: existing.id }, data: values });
      } else {
        await prisma.evaluation.create({
          data: { jobId, outputId: score.outputId, evaluatorKind: "deterministic", ...values },
        });
      }
    }

    await this.ctx.queue.enqueue(
      QUEUES.consensus,
      "consolidate",
      { jobId },
      { jobId: `consensus:${jobId}` },
    );

    return scores.length;
  }
}

/** Merges scored outputs into the job's final intelligence. */
export class ConsensusStage {
  private readonly engine: JobEngine;

  constructor(private readonly ctx: ProtocolContext) {
    this.engine = new JobEngine(ctx);
  }

  async run(jobId: string): Promise<void> {
    await this.engine.transition(jobId, "CONSENSUS", "merging agent outputs");

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { minimumConfidence: true, requiredCapabilities: true, requiredAgents: true },
    });
    if (!job) throw new JobEngineError(`Job ${jobId} not found`);

    const inputs = await loadConsensusInputs(jobId);
    if (inputs.length === 0) {
      await this.engine.fail(jobId, "no agent outputs to merge");
      return;
    }

    // The engine needs the size the job asked for, not just what turned up, so
    // a cohort that shrank is scored against its intended breadth.
    const outcome = this.ctx.consensus.run(inputs, { expectedCohortSize: job.requiredAgents });

    if (outcome.corroboration.short) {
      this.ctx.logger.warn("cohort finished short of the requested size", {
        jobId,
        finished: outcome.corroboration.cohortSize,
        requested: outcome.corroboration.expected,
        corroborationFactor: outcome.corroboration.factor,
      });
    }

    await prisma.consensusResult.upsert({
      where: { jobId },
      create: {
        jobId,
        strategy: outcome.strategy,
        strategyConfig: {
          ...outcome.strategyConfig,
          corroboration: outcome.corroboration,
        } as object,
        summary: outcome.summary,
        confidence: outcome.confidence,
        consensusScore: outcome.consensusScore,
        claims: outcome.claims as unknown as object,
        metrics: outcome.metrics as object,
        recommendation:
          outcome.recommendation === null ? Prisma.JsonNull : (outcome.recommendation as object),
        risks: outcome.risks as unknown as object,
        disagreements: outcome.disagreements as unknown as object,
        independence: outcome.independence as unknown as object,
        contributions: {
          create: outcome.contributions.map((c) => ({
            agentId: c.agentId,
            outputId: c.outputId,
            weight: c.weight,
            agreement: c.agreement,
            breakdown: c.breakdown as object,
          })),
        },
      },
      update: {
        strategy: outcome.strategy,
        summary: outcome.summary,
        confidence: outcome.confidence,
        consensusScore: outcome.consensusScore,
        claims: outcome.claims as unknown as object,
        // Rewritten with the summary that quotes it. A re-merge that refreshed
        // the wording and left the measurement behind would leave the two
        // disagreeing on the same page.
        independence: outcome.independence as unknown as object,
      },
    });

    // Record what each agent's cohort agreement was, as a reputation input.
    //
    // The overall (domain = null) snapshot is always written alongside the
    // domain-scoped ones. Writing only the domain rows left `domain: null`
    // permanently empty, and that is the row agent selection and the consensus
    // signals both read — so accuracy, calibration and evidence quality stayed
    // pinned at the neutral prior no matter how an agent actually performed.
    const domains: Array<string | null> = [null, ...job.requiredCapabilities];

    for (const contribution of outcome.contributions) {
      for (const domain of domains) {
        await prisma.reputationScore.create({
          data: {
            agentId: contribution.agentId,
            domain,
            ...(await this.recomputeVector(contribution.agentId, domain)),
            reason: `consensus on job ${jobId}`,
          },
        });
      }
    }

    // A job whose merged confidence misses its bar fails rather than shipping
    // intelligence the requester said they could not use.
    if (job.minimumConfidence !== null && outcome.confidence < job.minimumConfidence) {
      await this.engine.fail(
        jobId,
        `consensus confidence ${outcome.confidence.toFixed(3)} is below the required ${job.minimumConfidence}`,
        { confidence: outcome.confidence, consensusScore: outcome.consensusScore },
      );
      return;
    }

    await this.engine.transition(jobId, "RESOLVED", "consensus reached", {
      confidence: outcome.confidence,
      consensusScore: outcome.consensusScore,
      claims: outcome.claims.length,
      disagreements: outcome.disagreements.length,
      cohortSize: outcome.corroboration.cohortSize,
      expectedCohortSize: outcome.corroboration.expected,
    });

    await this.ctx.queue.enqueue(
      QUEUES.resolution,
      "reward",
      { jobId },
      { jobId: `reward:${jobId}` },
    );
  }

  /**
   * Recomputes an agent's reputation from its full observation history.
   *
   * Recomputing rather than incrementing means a change to the scoring rule
   * can be applied retroactively, and any snapshot can be reproduced.
   */
  private async recomputeVector(agentId: string, domain: string | null) {
    const [evaluations, predictions, contributions] = await Promise.all([
      prisma.evaluation.findMany({
        where: { output: { agentId } },
        select: { evidenceQuality: true, internalConsistency: true, overall: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.prediction.findMany({
        where: { claim: { output: { agentId } }, outcome: { in: ["TRUE", "FALSE"] } },
        select: { confidence: true, outcome: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.consensusContribution.findMany({
        where: { agentId },
        select: { agreement: true, consensus: { select: { createdAt: true } } },
        orderBy: { consensus: { createdAt: "desc" } },
        take: 200,
      }),
    ]);

    const { vector } = this.ctx.reputation.compute([
      ...evaluations.map((e) => ({
        kind: "evaluation" as const,
        evidenceQuality: e.evidenceQuality,
        internalConsistency: e.internalConsistency,
        overall: e.overall,
        domain,
        at: e.createdAt,
      })),
      ...predictions.map((p) => ({
        kind: "prediction" as const,
        confidence: p.confidence,
        outcomeWasTrue: p.outcome === "TRUE",
        domain,
        at: p.createdAt,
      })),
      ...contributions.map((c) => ({
        kind: "consensus" as const,
        agreement: c.agreement,
        domain,
        at: c.consensus.createdAt,
      })),
    ]);

    return vector;
  }
}

/**
 * Splits the job's budget once intelligence has been produced.
 *
 * Rewards are written as PENDING with the basis recorded; nothing is settled
 * on-chain here. Settlement is a separate, gated step — see `settlement.ts`.
 */
export class RewardStage {
  constructor(private readonly ctx: ProtocolContext) {}

  async run(jobId: string): Promise<void> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { budget: true, status: true },
    });
    if (!job || job.status !== "RESOLVED") return;

    const budget = toNumber(job.budget);
    if (budget <= 0) return;

    const existing = await prisma.reward.count({ where: { jobId } });
    if (existing > 0) return; // idempotent under redelivery

    const consensus = await prisma.consensusResult.findUnique({
      where: { jobId },
      include: { contributions: true },
    });
    if (!consensus) return;

    const split = splitReward(budget, this.ctx.env);

    // Agents share their slice in proportion to the weight they earned.
    const totalWeight = consensus.contributions.reduce((acc, c) => acc + c.weight, 0) || 1;

    await prisma.reward.createMany({
      data: [
        ...consensus.contributions.map((c) => ({
          jobId,
          agentId: c.agentId,
          role: "AGENT" as const,
          amount: (split.agents * (c.weight / totalWeight)).toFixed(6),
          basis: { weight: c.weight, share: c.weight / totalWeight, pool: split.agents } as object,
        })),
        { jobId, role: "VALIDATOR" as const, amount: split.validators.toFixed(6), basis: split as object },
        { jobId, role: "PROTOCOL" as const, amount: split.protocol.toFixed(6), basis: split as object },
        { jobId, role: "TREASURY" as const, amount: split.treasury.toFixed(6), basis: split as object },
      ],
    });

    this.ctx.logger.info("rewards recorded", { jobId, budget, split });
  }
}

