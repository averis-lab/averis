import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, toNumber } from "@averis/db";
import {
  JobEngine,
  claimFromStored,
  explainJob,
  type ProtocolContext,
  type StoredClaim,
} from "@averis/protocol";
import { CreateJobSchema, JobStatusSchema } from "@averis/types";
import { requesterScope } from "../auth";
import { paymentOf } from "../payments";

/**
 * How long an identical brief is treated as the same job.
 *
 * Long enough to cover an impatient double-submit and a browser back-button
 * retry; short enough that asking the same question again tomorrow — when the
 * corpus and the market have both moved — is a new job, which it genuinely is.
 */
const DUPLICATE_WINDOW_MS = 15 * 60_000;

const ListQuery = z.object({
  status: JobStatusSchema.optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export function registerJobRoutes(app: FastifyInstance, ctx: ProtocolContext): void {
  const engine = new JobEngine(ctx);

  app.post("/v1/jobs", async (request, reply) => {
    const parsed = CreateJobSchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      // The first issue is the `error` string as well as being in `issues`,
      // because that is the field clients surface. "Invalid job request" alone
      // told a requester nothing about which field to fix.
      return reply.code(400).send({
        error: issues[0]?.message ?? "Invalid job request",
        issues,
      });
    }

    /*
     * The same brief, asked twice, is one job.
     *
     * A submit button that redirects on success is a submit button people
     * press again when they are not sure it worked, and each press here buys a
     * fresh cohort and a fresh settlement to answer a question that is already
     * being answered. Rather than refuse outright, the existing job is handed
     * back: 409 with its id, so the caller can go and look at the answer it
     * already has instead of paying for a second copy of it.
     *
     * Scoped to the requester, because two accounts independently asking the
     * same question is not duplication — they each want their own result, and
     * one of them cannot see the other's job anyway.
     *
     * Only live jobs count. A brief that failed, or that resolved long enough
     * ago to be stale, is a legitimate thing to ask again.
     */
    const duplicate = await prisma.job.findFirst({
      where: {
        ...requesterScope(request.principal),
        query: parsed.data.query,
        type: parsed.data.type,
        status: { notIn: ["FAILED", "CANCELLED"] },
        createdAt: { gt: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (duplicate) {
      return reply.code(409).send({
        error: "An identical brief is already running or was just answered.",
        existingJobId: duplicate.id,
        existingStatus: duplicate.status,
      });
    }

    // The job is stamped with its requester, which is what later scopes every
    // read of it. A root key has no account, so its jobs stay unowned.
    //
    // When the x402 paywall is on, what was paid is recorded on the job itself:
    // the payment bought this job specifically, and splitting the two across
    // tables would mean reconciling them later.
    const payment = paymentOf(request);
    const jobId = await engine.create(
      payment
        ? { ...parsed.data, metadata: { ...parsed.data.metadata, payment } }
        : parsed.data,
      request.principal?.userId ?? null,
    );
    const job = await prisma.job.findUnique({ where: { id: jobId } });

    return reply.code(201).send({ data: serializeJob(job!) });
  });

  app.get("/v1/jobs", async (request, reply) => {
    const parsed = ListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query parameters" });

    const { status, type, limit, cursor } = parsed.data;

    const jobs = await prisma.job.findMany({
      where: {
        ...requesterScope(request.principal),
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        consensus: { select: { confidence: true, consensusScore: true } },
        _count: { select: { assignments: true, evidence: true } },
      },
    });

    const hasMore = jobs.length > limit;
    const page = hasMore ? jobs.slice(0, limit) : jobs;

    return reply.send({
      data: page.map((job) => ({
        ...serializeJob(job),
        confidence: job.consensus?.confidence ?? null,
        consensusScore: job.consensus?.consensusScore ?? null,
        agentCount: job._count.assignments,
        evidenceCount: job._count.evidence,
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id : null,
    });
  });

  app.get("/v1/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    // findFirst, not findUnique: the tenancy filter is part of the query, so
    // another account's job returns 404 rather than confirming it exists.
    const job = await prisma.job.findFirst({
      where: { id, ...requesterScope(request.principal) },
      include: {
        events: { orderBy: { createdAt: "asc" } },
        assignments: { include: { agent: { select: { id: true, name: true } } } },
        _count: { select: { evidence: true, outputs: true } },
      },
    });
    if (!job) return reply.code(404).send({ error: "Job not found" });

    return reply.send({
      data: {
        ...serializeJob(job),
        events: job.events.map((e) => ({
          from: e.from, to: e.to, reason: e.reason, at: e.createdAt, detail: e.detail,
        })),
        assignments: job.assignments.map((a) => ({
          agentId: a.agentId,
          agentName: a.agent.name,
          status: a.status,
          selectionScore: a.selectionScore,
          selectionDetail: a.selectionDetail,
          error: a.error,
        })),
        evidenceCount: job._count.evidence,
        outputCount: job._count.outputs,
      },
    });
  });

  /**
   * The job's finished intelligence: merged claims, the evidence behind each,
   * surfaced disagreements, and what each agent contributed.
   */
  app.get("/v1/jobs/:id/intelligence", async (request, reply) => {
    const { id } = request.params as { id: string };

    const job = await prisma.job.findFirst({
      where: { id, ...requesterScope(request.principal) },
      include: {
        consensus: {
          include: {
            contributions: {
              include: { agent: { select: { id: true, name: true } } },
              orderBy: { weight: "desc" },
            },
          },
        },
        outputs: {
          include: {
            agent: { select: { id: true, name: true } },
            evaluations: { where: { evaluatorKind: "deterministic" }, take: 1 },
            claims: {
              orderBy: { position: "asc" },
              include: { evidence: { include: { evidence: true } }, prediction: true },
            },
          },
        },
        evidence: true,
      },
    });

    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (!job.consensus) {
      return reply.code(409).send({
        error: "Intelligence is not available yet",
        status: job.status,
        ...(job.failureReason ? { reason: job.failureReason } : {}),
      });
    }

    return reply.send({
      data: {
        job: serializeJob(job),
        intelligence: {
          summary: job.consensus.summary,
          confidence: job.consensus.confidence,
          consensusScore: job.consensus.consensusScore,
          corroboration:
            (job.consensus.strategyConfig as { corroboration?: unknown } | null)?.corroboration ??
            null,
          strategy: job.consensus.strategy,
          strategyConfig: job.consensus.strategyConfig,
          claims: job.consensus.claims,
          metrics: job.consensus.metrics,
          recommendation: job.consensus.recommendation,
          risks: job.consensus.risks,
          disagreements: job.consensus.disagreements,
        },
        contributions: job.consensus.contributions.map((c) => ({
          agentId: c.agentId,
          agentName: c.agent.name,
          weight: c.weight,
          agreement: c.agreement,
          breakdown: c.breakdown,
        })),
        agentOutputs: job.outputs.map((output) => ({
          agentId: output.agentId,
          agentName: output.agent.name,
          summary: output.summary,
          confidence: output.confidence,
          metrics: output.metrics,
          risks: output.risks,
          cost: { tokensIn: output.tokensIn, tokensOut: output.tokensOut, usd: toNumber(output.costUsd) },
          durationMs: output.durationMs,
          evaluation: output.evaluations[0]
            ? {
                overall: output.evaluations[0].overall,
                evidenceQuality: output.evaluations[0].evidenceQuality,
                internalConsistency: output.evaluations[0].internalConsistency,
                specificity: output.evaluations[0].specificity,
                corroboration: output.evaluations[0].corroboration,
              }
            : null,
          claims: output.claims.map((claim) => ({
            statement: claim.statement,
            kind: claim.kind,
            confidence: claim.confidence,
            evidence: claim.evidence.map((link) => ({
              source: link.evidence.source,
              title: link.evidence.title,
              reliability: link.evidence.reliability,
              stance: link.stance,
            })),
            prediction: claim.prediction
              ? {
                  deadline: claim.prediction.deadline,
                  outcome: claim.prediction.outcome,
                  criteria: claim.prediction.criteria,
                }
              : null,
          })),
        })),
        evidence: job.evidence.map((e) => ({
          id: e.id,
          type: e.type,
          source: e.source,
          title: e.title,
          reliability: e.reliability,
          metadata: e.metadata,
          retrievedAt: e.retrievedAt,
        })),
      },
    });
  });

  /**
   * Why the job concluded what it concluded.
   *
   * Every number here was already computed during the merge; what this adds is
   * the chain that connects them — verdict, then claims, then the upstream
   * curation behind each piece of evidence. It reads the stored consensus
   * rather than re-deriving anything, because an explanation that recomputed
   * the analysis could disagree with the analysis it claims to explain.
   */
  app.get("/v1/jobs/:id/explain", async (request, reply) => {
    const { id } = request.params as { id: string };

    const job = await prisma.job.findFirst({
      where: { id, ...requesterScope(request.principal) },
      include: {
        consensus: true,
        outputs: {
          include: {
            agent: { select: { name: true } },
            evaluations: { where: { evaluatorKind: "deterministic" }, take: 1 },
          },
        },
      },
    });

    if (!job) return reply.code(404).send({ error: "Job not found" });
    if (!job.consensus) {
      return reply.code(409).send({
        error: "There is nothing to explain yet",
        status: job.status,
        ...(job.failureReason ? { reason: job.failureReason } : {}),
      });
    }

    const stored = (job.consensus.claims ?? []) as unknown as StoredClaim[];
    const claims = stored.map(claimFromStored);

    const corroboration =
      (job.consensus.strategyConfig as { corroboration?: Corroboration } | null)?.corroboration ??
      null;

    const explanation = explainJob({
      confidence: job.consensus.confidence,
      consensusScore: job.consensus.consensusScore,
      minimumConfidence: job.minimumConfidence,
      corroboration,
      claims,
      disagreements: (job.consensus.disagreements ?? []) as unknown as Array<{ statement: string }>,
      evaluations: job.outputs.flatMap((output) =>
        output.evaluations[0]
          ? [{ agentName: output.agent.name, overall: output.evaluations[0].overall }]
          : [],
      ),
    });

    return reply.send({
      data: { job: serializeJob(job), summary: job.consensus.summary, explanation },
    });
  });
}

interface Corroboration {
  cohortSize: number;
  expected: number;
  factor: number;
  short: boolean;
}

function serializeJob(job: {

  id: string; type: string; query: string; target: string | null;
  requiredCapabilities: string[]; requiredAgents: number; minimumConfidence: number | null;
  budget: unknown; deadline: Date | null; status: string; failureReason: string | null;
  datanetIds: string[]; createdAt: Date; updatedAt: Date; resolvedAt: Date | null;
}) {
  return {
    id: job.id,
    type: job.type,
    query: job.query,
    target: job.target,
    requiredCapabilities: job.requiredCapabilities,
    requiredAgents: job.requiredAgents,
    minimumConfidence: job.minimumConfidence,
    budget: toNumber(job.budget),
    deadline: job.deadline,
    status: job.status,
    failureReason: job.failureReason,
    datanetIds: job.datanetIds,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    resolvedAt: job.resolvedAt,
  };
}
