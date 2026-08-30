import "@averis/db/env";
import { disconnect, prisma } from "@averis/db";
import { MemoryQueueDriver } from "@averis/queue";
import { createContext, JobEngine, type Logger } from "@averis/protocol";
import { CreateJobSchema } from "@averis/types";
import { startJobWorker } from "../workers/src/job-worker/index";
import { startEvaluationWorker } from "../workers/src/evaluation-worker/index";
import { startConsensusWorker } from "../workers/src/consensus-worker/index";
import { startResolutionWorker } from "../workers/src/resolution-worker/index";

/**
 * The reference end-to-end demo.
 *
 * Runs the whole protocol in one process against an in-memory queue, so it
 * needs Postgres but not Redis, and no LLM API keys. The data is real: unless
 * REPPO_PROVIDER=fixture, it reads live Reppo Datanets over the public API.
 */

const QUIET: Logger = {
  info: () => {},
  warn: (message, detail) => console.error(`  ! ${message}`, detail ?? ""),
  error: (message, detail) => console.error(`  ✗ ${message}`, detail ?? ""),
};

const bar = (value: number, width = 24): string => {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const queue = new MemoryQueueDriver();

  const ctx = createContext({
    logger: verbose ? undefined : QUIET,
    overrides: { queue },
  });

  const engine = new JobEngine(ctx);

  const arg = (name: string): string | undefined =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

  // A job with no target names nothing tradable, so an automation can never
  // act on one. `--target=ETH --type=asset-analysis` produces intelligence the
  // execution layer can actually read.
  const target = arg("target") ?? null;

  const job = CreateJobSchema.parse({
    type: arg("type") ?? "dataset-evaluation",
    ...(target ? { target } : {}),
    query:
      process.argv.find((a) => a.startsWith("--query="))?.slice(8) ??
      "Assess whether the curated geopolitical and market intelligence in these Datanets is reliable enough for an autonomous trading agent to act on.",
    requiredCapabilities: ["markets", "geopolitics", "research"],
    requiredAgents: 3,
    budget: 3,
    minimumConfidence: 0.35,
    deadline: new Date(Date.now() + 4 * 60 * 1000),
  });

  console.log("\n╭─ INTELLIGENCE JOB ─────────────────────────────────────────────────");
  console.log(`│ type      ${job.type}`);
  console.log(`│ query     ${wrap(job.query, 62, "│           ")}`);
  console.log(`│ agents    ${job.requiredAgents} required · capabilities: ${job.requiredCapabilities.join(", ")}`);
  console.log(`│ budget    ${job.budget} USDC · min confidence ${job.minimumConfidence}`);
  console.log(`│ data      ${ctx.data.name} (${process.env["REPPO_PROVIDER"] ?? "http"}) · llm ${process.env["LLM_PROVIDER"] ?? "mock"}`);
  console.log("╰────────────────────────────────────────────────────────────────────\n");

  const job1 = startJobWorker(ctx);
  const evaluation = startEvaluationWorker(ctx);
  const consensus = startConsensusWorker(ctx);
  const resolution = startResolutionWorker(ctx);

  const started = Date.now();
  const jobId = await engine.create(job);
  console.log(`  job ${jobId} created → running pipeline...\n`);

  const status = await waitForTerminal(jobId);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  await queue.drained().catch(() => undefined);
  resolution.stop();
  await Promise.allSettled([
    job1.close(), evaluation.close(), consensus.close(), resolution.subscription.close(),
  ]);

  await report(jobId, status, elapsed);
  await disconnect();
}

async function waitForTerminal(jobId: string, timeoutMs = 180_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";

  while (Date.now() < deadline) {
    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!job) throw new Error("job disappeared");

    if (job.status !== last) {
      const stamp = new Date().toISOString().slice(11, 19);
      console.log(`  ${stamp}  ${job.status}`);
      last = job.status;
    }
    if (job.status === "RESOLVED" || job.status === "FAILED") return job.status;
    await new Promise((r) => setTimeout(r, 150));
  }
  return "TIMEOUT";
}

async function report(jobId: string, status: string, elapsed: string): Promise<void> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      consensus: { include: { contributions: { include: { agent: true } } } },
      outputs: { include: { agent: true, claims: true, evaluations: true } },
      evidence: true,
      rewards: true,
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!job) return;

  console.log(`\n  pipeline finished in ${elapsed}s → ${status}\n`);

  if (status !== "RESOLVED" || !job.consensus) {
    console.log(`  ✗ ${job.failureReason ?? "job did not resolve"}`);
    console.log(`\n  lifecycle: ${job.events.map((e) => e.to).join(" → ")}\n`);
    return;
  }

  const c = job.consensus;
  const claims = c.claims as Array<{
    statement: string; kind: string; confidence: number; support: number;
    supportedBy: string[]; contradictedBy: string[];
    supportingEvidence: Array<{ source: string; title: string | null; reliability: number }>;
  }>;
  const disagreements = c.disagreements as Array<{
    statement: string; supportWeight: number; opposeWeight: number;
    positions: Array<{ agentId: string; statement: string; confidence: number }>;
  }>;

  console.log("═".repeat(72));
  console.log("  FINAL INTELLIGENCE");
  console.log("═".repeat(72));
  console.log(`\n  ${wrap(c.summary, 68, "  ")}\n`);
  console.log(`  confidence   ${bar(c.confidence)}  ${pct(c.confidence)}`);
  console.log(`  consensus    ${bar(c.consensusScore)}  ${pct(c.consensusScore)}`);
  console.log(`  strategy     ${c.strategy}`);

  console.log(`\n  ── CLAIMS (${claims.length}) ${"─".repeat(48)}`);
  for (const [i, claim] of claims.entries()) {
    console.log(`\n  ${i + 1}. [${claim.kind}] ${wrap(claim.statement, 64, "     ")}`);
    console.log(`     confidence ${pct(claim.confidence)} · support ${pct(claim.support)} · ${claim.supportedBy.length} agent(s)`);
    if (claim.contradictedBy.length > 0) {
      console.log(`     ⚠ contradicted by ${claim.contradictedBy.length} agent(s)`);
    }
    for (const e of claim.supportingEvidence.slice(0, 2)) {
      console.log(`     └ ${e.source}  (reliability ${e.reliability.toFixed(2)})`);
      if (e.title) console.log(`       "${truncate(e.title, 58)}"`);
    }
    const extra = claim.supportingEvidence.length - 2;
    if (extra > 0) console.log(`     └ +${extra} more evidence item(s)`);
  }

  if (disagreements.length > 0) {
    console.log(`\n  ── DISAGREEMENTS (${disagreements.length}) ${"─".repeat(40)}`);
    console.log("  Surfaced rather than averaged away.\n");
    for (const d of disagreements) {
      console.log(`  · support ${pct(d.supportWeight)} vs oppose ${pct(d.opposeWeight)}`);
      for (const p of d.positions) {
        console.log(`      ${p.agentId.slice(0, 8)} @ ${pct(p.confidence)}: ${truncate(p.statement, 56)}`);
      }
    }
  }

  console.log(`\n  ── AGENT CONTRIBUTIONS ${"─".repeat(46)}`);
  for (const contribution of [...c.contributions].sort((a, b) => b.weight - a.weight)) {
    const output = job.outputs.find((o) => o.id === contribution.outputId);
    const evaluation = output?.evaluations[0];
    console.log(`\n  ${contribution.agent.name}`);
    console.log(`     weight     ${bar(contribution.weight, 16)} ${pct(contribution.weight)}`);
    console.log(`     agreement  ${pct(contribution.agreement)} · claims ${output?.claims.length ?? 0} · confidence ${pct(output?.confidence ?? 0)}`);
    if (evaluation) {
      console.log(
        `     evaluated  overall ${evaluation.overall.toFixed(2)} · evidence ${evaluation.evidenceQuality.toFixed(2)} · specificity ${evaluation.specificity.toFixed(2)} · corroboration ${evaluation.corroboration.toFixed(2)}`,
      );
    }
  }

  console.log(`\n  ── PROVENANCE ${"─".repeat(55)}`);
  console.log(`  ${job.evidence.length} evidence item(s) from ${job.datanetIds.length} Reppo Datanet(s)`);
  const byType = new Map<string, number>();
  for (const e of job.evidence) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  for (const [type, count] of byType) console.log(`     ${type}: ${count}`);

  if (job.rewards.length > 0) {
    console.log(`\n  ── REWARDS (pending, ${job.budget} USDC) ${"─".repeat(34)}`);
    for (const reward of job.rewards) {
      console.log(`     ${reward.role.padEnd(10)} ${Number(reward.amount).toFixed(4)} ${reward.currency}`);
    }
  }

  console.log(`\n  lifecycle: ${job.events.map((e) => e.to).join(" → ")}`);
  console.log(`\n${"═".repeat(72)}\n`);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if ((line + word).length > width) {
      lines.push(line.trimEnd());
      line = "";
    }
    line += `${word} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${indent}`);
}

main().catch((error: unknown) => {
  console.error("\ndemo failed:", error);
  void disconnect();
  process.exitCode = 1;
});
