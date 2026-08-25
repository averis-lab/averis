import { prisma } from "@averis/db";
import { MemoryQueueDriver } from "@averis/queue";
import { createContext, type Logger, type ProtocolContext } from "@averis/protocol";
import { startJobWorker } from "../../workers/src/job-worker/index";
import { startEvaluationWorker } from "../../workers/src/evaluation-worker/index";
import { startConsensusWorker } from "../../workers/src/consensus-worker/index";
import { startResolutionWorker } from "../../workers/src/resolution-worker/index";

/**
 * Runs the real lifecycle against a real database.
 *
 * Everything external is pinned to a deterministic stand-in — the in-process
 * queue, recorded Reppo fixtures, the mock LLM — so a failure means the
 * protocol misbehaved, not that a third party was slow. The database is the one
 * thing deliberately left real: every concurrency bug found in this codebase so
 * far lived in the gap between two database calls, and an in-memory fake would
 * have hidden all three.
 */

export const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface Harness {
  ctx: ProtocolContext;
  queue: MemoryQueueDriver;
  stop: () => Promise<void>;
}

/** Boots the four lifecycle workers against an in-process queue. */
export function startPipeline(overrides: Partial<ProtocolContext> = {}): Harness {
  const queue = new MemoryQueueDriver();
  const ctx = createContext({ logger: silent, overrides: { queue, ...overrides } });

  const job = startJobWorker(ctx);
  const evaluation = startEvaluationWorker(ctx);
  const consensus = startConsensusWorker(ctx);
  const resolution = startResolutionWorker(ctx);

  return {
    ctx,
    queue,
    stop: async () => {
      resolution.stop();
      await Promise.allSettled([
        job.close(),
        evaluation.close(),
        consensus.close(),
        resolution.subscription.close(),
      ]);
      await queue.close();
    },
  };
}

/**
 * Empties every table between cases.
 *
 * One statement so foreign keys never block the order, and `RESTART IDENTITY`
 * so a leaked sequence cannot make one test depend on another having run.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      claim_evidence, prediction_resolutions, predictions, claims, evidence,
      agent_outputs, evaluations, consensus_contributions, consensus_results,
      job_assignments, job_events, rewards, transactions, budget_spends, jobs,
      reputation_scores, agent_capabilities, agents, data_items, datanets,
      data_sources, operators, users
    RESTART IDENTITY CASCADE
  `);
}

export interface SeedAgent {
  name: string;
  domains: string[];
  tools?: string[];
  pricePerJob?: number;
  maxConcurrent?: number;
}

/** Registers a data source and a cohort of agents for one test. */
export async function seedRegistry(agents: SeedAgent[]): Promise<void> {
  await prisma.dataSource.upsert({
    where: { name: "reppo" },
    create: { name: "reppo", kind: "REPPO", baseUrl: "https://reppo.ai/api/v1" },
    update: {},
  });

  for (const spec of agents) {
    await prisma.agent.create({
      data: {
        name: spec.name,
        description: `You are ${spec.name}.`,
        modelProvider: "mock",
        modelName: "mock-analyst",
        tools: spec.tools ?? [
          "reppo_list_datanets",
          "reppo_search_data",
          "reppo_get_datanet_data",
          "compute_evidence_stats",
        ],
        pricePerJob: (spec.pricePerJob ?? 0.1).toFixed(6),
        maxConcurrent: spec.maxConcurrent ?? 3,
        capabilities: {
          create: spec.domains.map((domain) => ({ domain, skill: null, declared: 0.9 })),
        },
      },
    });
  }
}

/** Blocks until the job reaches a terminal state, or fails the test. */
export async function waitForTerminal(jobId: string, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!job) throw new Error(`job ${jobId} disappeared`);
    if (job.status === "RESOLVED" || job.status === "FAILED" || job.status === "CANCELLED") {
      return job.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const events = await prisma.jobEvent.findMany({
    where: { jobId },
    orderBy: { createdAt: "asc" },
    select: { to: true, reason: true },
  });
  throw new Error(
    `job ${jobId} never reached a terminal state. Lifecycle so far: ` +
      events.map((e) => `${e.to}(${e.reason ?? ""})`).join(" → "),
  );
}

/** The status path a job actually took, in order. */
export async function lifecycleOf(jobId: string): Promise<string[]> {
  const events = await prisma.jobEvent.findMany({
    where: { jobId },
    orderBy: { createdAt: "asc" },
    select: { to: true },
  });
  return events.map((e) => e.to);
}
