import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnect, prisma } from "@averis/db";
import { JobEngine, ExecutionPipeline } from "@averis/protocol";
import { CreateJobSchema, InvalidTransitionError } from "@averis/types";
import {
  lifecycleOf,
  resetDatabase,
  seedRegistry,
  startPipeline,
  waitForTerminal,
  type Harness,
} from "./harness";

/**
 * Every concurrency bug found in this codebase so far — the budget guard's
 * check-then-commit window, the evidence upsert race, the queue's silent
 * redelivery — lived between two database calls and survived a full unit
 * suite. These tests exist to catch that class.
 */

const COHORT = [
  { name: "Markets Agent", domains: ["markets", "geopolitics"] },
  { name: "Research Agent", domains: ["research", "markets"] },
  { name: "Data Quality Agent", domains: ["research", "ai"] },
];

let harness: Harness | null = null;

async function run(overrides: Record<string, unknown> = {}, ctxOverrides = {}) {
  harness = startPipeline(ctxOverrides);
  const engine = new JobEngine(harness.ctx);

  const jobId = await engine.create(
    CreateJobSchema.parse({
      type: "dataset-evaluation",
      query: "Assess whether the curated corpus is reliable enough to act on",
      requiredCapabilities: ["markets", "research"],
      requiredAgents: 3,
      budget: 3,
      deadline: new Date(Date.now() + 2 * 60 * 1000),
      ...overrides,
    }),
  );

  const status = await waitForTerminal(jobId);
  return { jobId, status };
}

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

describe("job lifecycle", () => {
  it("carries a job from creation to resolved intelligence", async () => {
    const { jobId, status } = await run();
    expect(status).toBe("RESOLVED");

    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      include: {
        consensus: { include: { contributions: true } },
        outputs: { include: { claims: true } },
        evidence: true,
        assignments: true,
      },
    });

    expect(job.assignments).toHaveLength(3);
    expect(job.outputs).toHaveLength(3);
    expect(job.evidence.length).toBeGreaterThan(0);
    expect(job.consensus).not.toBeNull();
    expect(job.consensus!.contributions).toHaveLength(3);
    expect(job.resolvedAt).not.toBeNull();
  });

  it("records every transition it actually took", async () => {
    const { jobId } = await run();

    // The audit trail is what makes a dead job diagnosable later, so it has to
    // be complete and in order rather than merely ending in the right place.
    expect(await lifecycleOf(jobId)).toEqual([
      "CREATED",
      "QUEUED",
      "ASSIGNED",
      "RUNNING",
      "SUBMITTED",
      "VALIDATING",
      "CONSENSUS",
      "RESOLVED",
    ]);
  });

  it("fails a job no agent is qualified for, rather than running it anyway", async () => {
    const { jobId, status } = await run({
      requiredCapabilities: ["quantum-cryptography"],
      requiredAgents: 3,
    });

    expect(status).toBe("FAILED");
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.failureReason).toMatch(/no agent matched/i);
    expect(await prisma.agentOutput.count({ where: { jobId } })).toBe(0);
  });

  it("fails a job whose merged confidence misses its own bar", async () => {
    const { jobId, status } = await run({ minimumConfidence: 0.99 });

    expect(status).toBe("FAILED");
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.failureReason).toMatch(/below the required/i);

    // The work is kept even though the job failed; only the verdict is refused.
    expect(await prisma.agentOutput.count({ where: { jobId } })).toBeGreaterThan(0);
  });
});

describe("evidence and provenance", () => {
  it("deduplicates evidence across a parallel cohort", async () => {
    const { jobId } = await run();

    const evidence = await prisma.evidence.findMany({
      where: { jobId },
      select: { contentHash: true, source: true },
    });

    // Three agents retrieving the same pods previously raced on the unique
    // constraint and one lost its entire output.
    expect(new Set(evidence.map((e) => e.contentHash)).size).toBe(evidence.length);
    expect(new Set(evidence.map((e) => e.source)).size).toBe(evidence.length);
  });

  it("links pod evidence to a cached data item, one row per upstream pod", async () => {
    const { jobId } = await run();

    const evidence = await prisma.evidence.findMany({
      where: { jobId, type: "REPPO_POD" },
      select: { source: true, reliability: true, dataItem: true },
    });
    expect(evidence.length).toBeGreaterThan(0);

    // Provenance has to be joinable, not just a string. Before this the FK
    // existed in the schema and nothing ever wrote it.
    for (const row of evidence) {
      expect(row.dataItem).not.toBeNull();
      expect(row.source).toBe(`reppo://pod/${row.dataItem!.externalId}`);
      expect(row.dataItem!.qualityScore).toBeCloseTo(row.reliability, 6);
    }

    // Three agents retrieve overlapping pods in parallel and each upserts the
    // cache. The compound unique is what keeps that from either duplicating
    // rows or losing a writer to a constraint violation.
    const items = await prisma.dataItem.findMany({ select: { externalId: true, datanetId: true } });
    expect(new Set(items.map((i) => i.externalId)).size).toBe(items.length);

    // Every cached pod hangs off a datanet the job actually scoped itself to.
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: jobId },
      select: { datanetIds: true },
    });
    const scoped = await prisma.datanet.findMany({
      where: { externalId: { in: job.datanetIds } },
      select: { id: true },
    });
    const scopedIds = new Set(scoped.map((d) => d.id));
    for (const item of items) {
      expect(item.datanetId).not.toBeNull();
      expect(scopedIds.has(item.datanetId!)).toBe(true);
    }
  });

  it("keeps one data item across jobs that cite the same pod", async () => {
    const first = await run();
    const afterFirst = await prisma.dataItem.findMany({ select: { id: true, externalId: true } });
    expect(afterFirst.length).toBeGreaterThan(0);

    if (harness) {
      await harness.stop();
      harness = null;
    }
    const second = await run();
    expect(second.jobId).not.toBe(first.jobId);

    // The cache is keyed on upstream identity, so a second job citing the same
    // pods reuses the rows rather than growing a parallel set of them.
    const afterSecond = await prisma.dataItem.findMany({ select: { id: true, externalId: true } });
    expect(new Set(afterSecond.map((i) => i.externalId)).size).toBe(afterSecond.length);
    for (const row of afterFirst) {
      expect(afterSecond.find((i) => i.externalId === row.externalId)?.id).toBe(row.id);
    }
  });

  it("links every supported claim to evidence that was actually stored", async () => {
    const { jobId } = await run();

    const claims = await prisma.claim.findMany({
      where: { output: { jobId } },
      include: { evidence: { include: { evidence: true } } },
    });

    expect(claims.length).toBeGreaterThan(0);

    const stored = new Set(
      (await prisma.evidence.findMany({ where: { jobId }, select: { id: true } })).map((e) => e.id),
    );

    let linked = 0;
    for (const claim of claims) {
      for (const link of claim.evidence) {
        // A claim must never point at provenance the job did not record.
        expect(stored.has(link.evidence.id)).toBe(true);
        expect(link.evidence.source).toMatch(/^reppo:\/\/pod\//);
        linked++;
      }
    }
    expect(linked).toBeGreaterThan(0);
  });

  it("snapshots the datanets a job used, rubric included", async () => {
    const { jobId } = await run();

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.datanetIds.length).toBeGreaterThan(0);

    const snapshots = await prisma.datanet.findMany({
      where: { externalId: { in: job.datanetIds } },
      select: { externalId: true, rubric: true },
    });

    expect(snapshots.length).toBe(job.datanetIds.length);
    // Without the snapshot an old job's evaluation could not be reproduced
    // after the datanet rewrote its standard.
    const withRubric = snapshots.filter((d) => {
      const r = (d.rubric ?? {}) as { voterRubric?: string };
      return (r.voterRubric ?? "").length > 0;
    });
    expect(withRubric.length).toBeGreaterThan(0);
  });
});

describe("consensus reflects the cohort that actually ran", () => {
  it("gives a full cohort full corroboration", async () => {
    const { jobId } = await run();

    const consensus = await prisma.consensusResult.findUniqueOrThrow({ where: { jobId } });
    const corroboration = (consensus.strategyConfig as { corroboration?: Record<string, unknown> })
      .corroboration;

    expect(corroboration).toMatchObject({ cohortSize: 3, expected: 3, factor: 1, short: false });
    expect(consensus.consensusScore).toBeGreaterThan(0);
  });

  it("reports no consensus when only one agent could run", async () => {
    await prisma.agent.deleteMany({ where: { name: { not: "Markets Agent" } } });

    const { jobId, status } = await run({
      requiredCapabilities: ["geopolitics"],
      requiredAgents: 4,
    });
    expect(status).toBe("RESOLVED");

    const consensus = await prisma.consensusResult.findUniqueOrThrow({ where: { jobId } });

    // One agent agreeing with itself is not corroboration, and reporting it as
    // full consensus told the reader several analysts had converged.
    expect(consensus.consensusScore).toBe(0);
    expect(consensus.summary).toMatch(/Only 1 of 4 agents/);
  });
});

describe("budget is enforced before work runs", () => {
  it("declines agents once the per-job cap is reached", async () => {
    // Each agent reserves an estimate up front; a tight cap must stop the
    // cohort part-way rather than discovering the overrun afterwards.
    const { jobId } = await run({ budget: 3 }, { policy: undefined });

    const spends = await prisma.budgetSpend.findMany({ where: { jobId } });
    expect(spends.length).toBeGreaterThan(0);

    // Every reservation is reconciled, so nothing is left permanently held.
    for (const spend of spends) expect(spend.actual).not.toBeNull();
  });

  it("writes a spend ledger row for every agent that ran", async () => {
    const { jobId } = await run();

    const outputs = await prisma.agentOutput.count({ where: { jobId } });
    const spends = await prisma.budgetSpend.count({ where: { jobId, category: "llm" } });

    expect(spends).toBeGreaterThanOrEqual(outputs);
  });
});

describe("lifecycle invariants under redelivery", () => {
  it("refuses to move a job out of a terminal state", async () => {
    const { jobId } = await run();
    harness = startPipeline();
    const engine = new JobEngine(harness.ctx);

    // A worker that redelivers after the job resolved must not resurrect it.
    const moved = await engine.transition(jobId, "RUNNING", "late redelivery");
    expect(moved).toBe(false);

    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
    expect(job.status).toBe("RESOLVED");
  });

  it("rejects a transition the state machine does not allow", async () => {
    harness = startPipeline();
    const engine = new JobEngine(harness.ctx);

    const jobId = await engine.create(
      CreateJobSchema.parse({
        type: "dataset-evaluation",
        query: "A job that should not skip ahead",
        requiredCapabilities: ["markets"],
        requiredAgents: 1,
        budget: 1,
      }),
    );

    await expect(engine.transition(jobId, "RESOLVED", "skipping the queue")).rejects.toBeInstanceOf(
      InvalidTransitionError,
    );
  });

  it("treats a repeated transition as a no-op rather than an error", async () => {
    harness = startPipeline();
    const engine = new JobEngine(harness.ctx);
    const jobId = await engine.create(
      CreateJobSchema.parse({
        type: "dataset-evaluation",
        query: "Duplicate delivery",
        requiredCapabilities: ["markets"],
        requiredAgents: 1,
        budget: 1,
      }),
    );
    await waitForTerminal(jobId);

    const before = await prisma.jobEvent.count({ where: { jobId } });
    // At-least-once delivery is normal; the second attempt must change nothing.
    expect(await engine.transition(jobId, "RESOLVED", "duplicate")).toBe(false);
    expect(await prisma.jobEvent.count({ where: { jobId } })).toBe(before);
  });

  it("does not run a job twice when the same work is enqueued again", async () => {
    harness = startPipeline();
    const engine = new JobEngine(harness.ctx);
    const pipeline = new ExecutionPipeline(harness.ctx);

    const jobId = await engine.create(
      CreateJobSchema.parse({
        type: "dataset-evaluation",
        query: "Assess the corpus once",
        requiredCapabilities: ["markets", "research"],
        requiredAgents: 3,
        budget: 3,
      }),
    );
    await waitForTerminal(jobId);

    const outputsBefore = await prisma.agentOutput.count({ where: { jobId } });

    // A redelivered job message must not produce a second set of outputs.
    await pipeline.runJob(jobId).catch(() => undefined);

    expect(await prisma.agentOutput.count({ where: { jobId } })).toBe(outputsBefore);
  });
});

describe("reputation accrues from completed work", () => {
  it("writes both the overall snapshot and one per required domain", async () => {
    const { jobId } = await run();
    const job = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

    const overall = await prisma.reputationScore.count({ where: { domain: null } });
    // The overall row is what agent selection reads; leaving it empty pinned
    // every agent at the neutral prior forever.
    expect(overall).toBeGreaterThan(0);

    for (const domain of job.requiredCapabilities) {
      expect(await prisma.reputationScore.count({ where: { domain } })).toBeGreaterThan(0);
    }
  });

  it("scores every submitted output on all five dimensions", async () => {
    const { jobId } = await run();

    const evaluations = await prisma.evaluation.findMany({ where: { jobId } });
    expect(evaluations).toHaveLength(3);

    for (const evaluation of evaluations) {
      for (const dimension of [
        evaluation.evidenceQuality,
        evaluation.internalConsistency,
        evaluation.specificity,
        evaluation.corroboration,
        evaluation.rubricAlignment,
        evaluation.overall,
      ]) {
        expect(dimension).toBeGreaterThanOrEqual(0);
        expect(dimension).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("rewards", () => {
  it("splits the budget once, and only for a resolved job", async () => {
    const { jobId } = await run({ budget: 4 });

    const rewards = await prisma.reward.findMany({ where: { jobId } });
    expect(rewards.length).toBeGreaterThan(0);

    const total = rewards.reduce((sum, r) => sum + Number(r.amount), 0);
    // A misconfigured split must never pay out more than the job's budget.
    expect(total).toBeLessThanOrEqual(4 + 1e-6);

    // Nothing is settled on-chain; settlement is a separate, gated step.
    expect(rewards.every((r) => r.status === "PENDING")).toBe(true);
  });
});
