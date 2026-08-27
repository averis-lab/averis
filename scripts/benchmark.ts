import "@averis/db/env";
import { disconnect, prisma, toNumber } from "@averis/db";
import { MemoryQueueDriver } from "@averis/queue";
import { createContext, JobEngine, type Logger } from "@averis/protocol";
import { CreateJobSchema } from "@averis/types";
import { startJobWorker } from "../workers/src/job-worker/index";
import { startEvaluationWorker } from "../workers/src/evaluation-worker/index";
import { startConsensusWorker } from "../workers/src/consensus-worker/index";
import { startResolutionWorker } from "../workers/src/resolution-worker/index";

/**
 * Cohort benchmark: what a larger cohort costs, and what it buys.
 *
 * Runs the *same* question at several cohort sizes and puts the results side
 * by side. Same query, same corpus, same budget per agent — the only variable
 * is how many analysts were on it.
 *
 * What it deliberately does not report is **accuracy**. Accuracy needs ground
 * truth, ground truth comes from resolved predictions, and no prediction has
 * reached a deadline yet — that is phase 2. Reporting an accuracy number here
 * would mean inventing the thing the whole protocol exists to measure
 * honestly. What can be measured today is real and useful on its own: cost,
 * latency, how much the cohort agreed, how much evidence it stood on, and how
 * often it surfaced a disagreement rather than papering over one.
 *
 *   npx tsx scripts/benchmark.ts
 *   npx tsx scripts/benchmark.ts --sizes=1,3,5 --repeat=3
 *   npx tsx scripts/benchmark.ts --query="…" --capabilities=markets,research
 */

const QUIET: Logger = {
  info: () => {},
  warn: () => {},
  error: (message, detail) => console.error(`  ✗ ${message}`, detail ?? ""),
};

interface RunResult {
  size: number;
  status: string;
  wallMs: number;
  costUsd: number;
  agentRuns: number;
  avgAgentMs: number;
  maxAgentMs: number;
  confidence: number | null;
  consensus: number | null;
  claims: number;
  claimsWithEvidence: number;
  evidence: number;
  disagreements: number;
}

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const sizes = (arg("sizes") ?? "1,3,5")
    .split(",")
    .map((n) => Number.parseInt(n.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);

  const repeat = Math.max(1, Number.parseInt(arg("repeat") ?? "1", 10) || 1);
  const budgetPerAgent = Number.parseFloat(arg("budget-per-agent") ?? "1") || 1;

  const query =
    arg("query") ??
    "Assess whether the curated geopolitical and market intelligence in these Datanets is reliable enough for an autonomous trading agent to act on.";
  const capabilities = (arg("capabilities") ?? "markets,geopolitics,research")
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

  const provider = process.env["LLM_PROVIDER"] ?? "mock";

  console.log("\n╭─ COHORT BENCHMARK ─────────────────────────────────────────────────");
  console.log(`│ sizes      ${sizes.join(", ")} agents · ${repeat} run(s) each`);
  console.log(`│ budget     ${budgetPerAgent} USDC per agent`);
  console.log(`│ data       ${process.env["REPPO_PROVIDER"] ?? "http"} · llm ${provider}`);
  if (provider === "mock") {
    console.log("│");
    console.log("│ NOTE  Every agent is bound to the deterministic provider, so this");
    console.log("│       measures the coordination, not the intelligence. Cost and");
    console.log("│       latency in particular are not what real models would charge.");
  }
  console.log("╰────────────────────────────────────────────────────────────────────\n");

  const results: RunResult[] = [];

  for (const size of sizes) {
    for (let attempt = 1; attempt <= repeat; attempt++) {
      process.stdout.write(`  ${size} agent(s), run ${attempt}/${repeat} … `);
      const run = await runOnce({ size, query, capabilities, budgetPerAgent });
      results.push(run);
      console.log(`${run.status} in ${(run.wallMs / 1000).toFixed(1)}s`);
    }
  }

  report(results, sizes);
  await disconnect();
}

async function runOnce(opts: {
  size: number;
  query: string;
  capabilities: string[];
  budgetPerAgent: number;
}): Promise<RunResult> {
  const queue = new MemoryQueueDriver();
  const ctx = createContext({ logger: QUIET, overrides: { queue } });
  const engine = new JobEngine(ctx);

  const spec = CreateJobSchema.parse({
    type: "dataset-evaluation",
    query: opts.query,
    requiredCapabilities: opts.capabilities,
    requiredAgents: opts.size,
    // Scaled with the cohort, so a larger one is not starved by a flat cap and
    // the comparison stays about the cohort rather than about the budget.
    budget: opts.budgetPerAgent * opts.size,
    // No confidence floor. With one the smaller cohorts fail their own
    // threshold and produce no consensus to compare against, which measures
    // the floor rather than the cohort.
    deadline: new Date(Date.now() + 4 * 60 * 1000),
  });

  const jobWorker = startJobWorker(ctx);
  const evaluation = startEvaluationWorker(ctx);
  const consensus = startConsensusWorker(ctx);
  const resolution = startResolutionWorker(ctx);

  const started = Date.now();
  const jobId = await engine.create(spec);
  const status = await waitForTerminal(jobId);
  const wallMs = Date.now() - started;

  await queue.drained().catch(() => undefined);
  resolution.stop();
  await Promise.allSettled([
    jobWorker.close(),
    evaluation.close(),
    consensus.close(),
    resolution.subscription.close(),
  ]);

  return measure(jobId, opts.size, status, wallMs);
}

async function waitForTerminal(jobId: string, timeoutMs = 240_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!job) throw new Error("job disappeared");
    if (job.status === "RESOLVED" || job.status === "FAILED") return job.status;
    await new Promise((r) => setTimeout(r, 150));
  }
  return "TIMEOUT";
}

async function measure(
  jobId: string,
  size: number,
  status: string,
  wallMs: number,
): Promise<RunResult> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      consensus: true,
      outputs: { include: { claims: { include: { evidence: true } } } },
      evidence: true,
    },
  });

  const outputs = job?.outputs ?? [];
  const durations = outputs.map((o) => o.durationMs).filter((d) => d > 0);
  const claims = outputs.flatMap((o) => o.claims);
  const disagreements = Array.isArray(job?.consensus?.disagreements)
    ? (job.consensus.disagreements as unknown[]).length
    : 0;

  return {
    size,
    status,
    wallMs,
    costUsd: outputs.reduce((sum, o) => sum + toNumber(o.costUsd), 0),
    agentRuns: outputs.length,
    avgAgentMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    maxAgentMs: durations.length ? Math.max(...durations) : 0,
    confidence: job?.consensus?.confidence ?? null,
    consensus: job?.consensus?.consensusScore ?? null,
    claims: claims.length,
    claimsWithEvidence: claims.filter((c) => c.evidence.length > 0).length,
    evidence: job?.evidence.length ?? 0,
    disagreements,
  };
}

/** Averages the repeats for a size, so one slow run does not read as a trend. */
function fold(runs: RunResult[]): Record<string, string> {
  const n = runs.length;
  const avg = (pick: (r: RunResult) => number): number =>
    runs.reduce((sum, r) => sum + pick(r), 0) / n;
  const defined = runs.filter((r) => r.confidence !== null);

  const ms = (value: number): string => (value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`);
  const pct = (value: number | null): string => (value === null ? "—" : `${(value * 100).toFixed(0)}%`);

  return {
    runs: `${runs.filter((r) => r.status === "RESOLVED").length}/${n}`,
    wall: ms(avg((r) => r.wallMs)),
    cost: `$${avg((r) => r.costUsd).toFixed(4)}`,
    agentLatency: ms(avg((r) => r.avgAgentMs)),
    confidence: pct(defined.length ? defined.reduce((s, r) => s + (r.confidence ?? 0), 0) / defined.length : null),
    consensus: pct(defined.length ? defined.reduce((s, r) => s + (r.consensus ?? 0), 0) / defined.length : null),
    evidence: avg((r) => r.evidence).toFixed(0),
    coverage:
      avg((r) => r.claims) > 0
        ? `${((avg((r) => r.claimsWithEvidence) / avg((r) => r.claims)) * 100).toFixed(0)}%`
        : "—",
    conflicts: avg((r) => r.disagreements).toFixed(1),
  };
}

const COLUMNS: [keyof ReturnType<typeof fold>, string, number][] = [
  ["runs", "resolved", 9],
  ["wall", "wall", 8],
  ["cost", "cost", 10],
  ["agentLatency", "agent", 8],
  ["confidence", "conf", 6],
  ["consensus", "consen", 7],
  ["evidence", "evid", 6],
  ["coverage", "cited", 7],
  ["conflicts", "conflict", 9],
];

function report(results: RunResult[], sizes: number[]): void {
  console.log("\n╭─ RESULTS ──────────────────────────────────────────────────────────");
  const header = ["agents".padEnd(8), ...COLUMNS.map(([, label, w]) => label.padStart(w))].join("");
  console.log(`│ ${header}`);
  console.log(`│ ${"─".repeat(header.length)}`);

  for (const size of sizes) {
    const runs = results.filter((r) => r.size === size);
    if (runs.length === 0) continue;
    const folded = fold(runs);
    const row = [
      String(size).padEnd(8),
      ...COLUMNS.map(([key, , w]) => folded[key]!.padStart(w)),
    ].join("");
    console.log(`│ ${row}`);
  }

  console.log("╰────────────────────────────────────────────────────────────────────");
  console.log("\n  cited     share of claims that cite at least one evidence record");
  console.log("  conflict  disagreements the merge surfaced instead of averaging away");
  console.log("\n  Accuracy is absent on purpose: it needs resolved predictions, which");
  console.log("  is phase 2. Everything above is measured, not estimated.\n");
}

main().catch((error: unknown) => {
  console.error("benchmark failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
