import { prisma, toDecimalInput, toNumber, type JobStatus as DbJobStatus } from "@averis/db";
import { QUEUES } from "@averis/queue";
import {
  assertTransition,
  isTerminal,
  NEUTRAL_REPUTATION,
  type AgentDescriptor,
  type CreateJob,
  type JobStatus,
  type ReputationVector,
} from "@averis/types";
import type { ProtocolContext } from "./context";

export class JobEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobEngineError";
  }
}

/**
 * Owns every job state change.
 *
 * Two rules are enforced here and nowhere else:
 *
 *  1. **Transitions go through the state machine.** Queues deliver at least
 *     once, so a duplicated or out-of-order message is normal. Validating the
 *     transition against the job's *current persisted* status inside a
 *     transaction is what makes redelivery harmless.
 *  2. **Every transition is audited.** A `JobEvent` row is written with each
 *     change, so the path a job took is reconstructible long after the fact.
 */
export class JobEngine {
  constructor(private readonly ctx: ProtocolContext) {}

  async create(input: CreateJob, requesterId: string | null = null): Promise<string> {
    const job = await prisma.job.create({
      data: {
        requesterId,
        type: input.type,
        query: input.query,
        target: input.target,
        requiredCapabilities: input.requiredCapabilities,
        requiredAgents: input.requiredAgents,
        minimumConfidence: input.minimumConfidence,
        budget: toDecimalInput(input.budget),
        deadline: input.deadline,
        datanetIds: input.datanetIds,
        metadata: input.metadata as object,
        status: "CREATED",
        events: { create: { to: "CREATED", reason: "job created" } },
      },
      select: { id: true },
    });

    await this.transition(job.id, "QUEUED", "queued for agent selection");
    await this.ctx.queue.enqueue(
      QUEUES.job,
      "select-and-run",
      { jobId: job.id },
      // Deduplicated by job id: a retried enqueue cannot start a second run.
      { jobId: `job:${job.id}` },
    );

    return job.id;
  }

  /**
   * Moves a job to `next`, rejecting any transition the lifecycle forbids.
   *
   * Returns false when the job is already in the target state — an expected
   * outcome under at-least-once delivery, and not an error.
   */
  async transition(
    jobId: string,
    next: JobStatus,
    reason: string,
    detail: Record<string, unknown> = {},
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id: jobId }, select: { status: true } });
      if (!job) throw new JobEngineError(`Job ${jobId} not found`);

      const current = job.status as JobStatus;
      if (current === next) return false;

      if (isTerminal(current)) {
        // Terminal is terminal. A late worker must not resurrect a job that
        // already failed or resolved.
        this.ctx.logger.warn("ignoring transition out of a terminal state", {
          jobId,
          current,
          next,
        });
        return false;
      }

      assertTransition(current, next);

      await tx.job.update({
        where: { id: jobId },
        data: {
          status: next as DbJobStatus,
          ...(next === "RESOLVED" ? { resolvedAt: new Date() } : {}),
          ...(next === "FAILED" ? { failureReason: reason } : {}),
        },
      });

      await tx.jobEvent.create({
        data: { jobId, from: current as DbJobStatus, to: next as DbJobStatus, reason, detail: detail as object },
      });

      return true;
    });
  }

  async fail(jobId: string, reason: string, detail: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.transition(jobId, "FAILED", reason, detail);
    } catch (error) {
      this.ctx.logger.error("could not mark job failed", {
        jobId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Loads every active agent with the reputation the selector needs.
   *
   * Reputation is read from the latest snapshot per (agent, domain) rather
   * than recomputed, so selection is fast and reproducible: the same snapshots
   * always yield the same cohort.
   */
  async candidates(): Promise<AgentDescriptor[]> {
    const agents = await prisma.agent.findMany({
      where: { status: "ACTIVE" },
      include: {
        capabilities: true,
        reputation: { orderBy: { createdAt: "desc" }, take: 40 },
        assignments: {
          where: { status: { in: ["PENDING", "ACCEPTED", "RUNNING"] } },
          select: { id: true },
        },
      },
    });

    return agents.map((agent) => {
      const overall = latestFor(agent.reputation, null);
      const domainReputation: Record<string, ReputationVector> = {};

      for (const snapshot of agent.reputation) {
        if (snapshot.domain === null) continue;
        if (domainReputation[snapshot.domain]) continue; // first is newest
        domainReputation[snapshot.domain] = toVector(snapshot);
      }

      return {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        capabilities: agent.capabilities.map((c) => ({
          domain: c.domain,
          skill: c.skill,
          declared: c.declared,
        })),
        modelProvider: agent.modelProvider,
        modelName: agent.modelName,
        tools: agent.tools,
        pricePerJob: toNumber(agent.pricePerJob),
        maxConcurrent: agent.maxConcurrent,
        activeAssignments: agent.assignments.length,
        reputation: overall,
        domainReputation,
      };
    });
  }
}

type SnapshotRow = {
  domain: string | null;
  overall: number;
  accuracy: number;
  calibration: number;
  consistency: number;
  evidenceQuality: number;
  sampleSize: number;
};

function toVector(row: SnapshotRow): ReputationVector {
  return {
    overall: row.overall,
    accuracy: row.accuracy,
    calibration: row.calibration,
    consistency: row.consistency,
    evidenceQuality: row.evidenceQuality,
    sampleSize: row.sampleSize,
  };
}

function latestFor(rows: SnapshotRow[], domain: string | null): ReputationVector {
  const row = rows.find((r) => r.domain === domain);
  // A never-scored agent starts at neutral, never at zero — otherwise no new
  // agent could ever accumulate a record.
  return row ? toVector(row) : { ...NEUTRAL_REPUTATION };
}
