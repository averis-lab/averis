import "@averis/db/env";
import { disconnect, prisma } from "@averis/db";
import { createContext, type Logger } from "@averis/protocol";
import { loadOperatorConfig } from "../apps/operator/src/config";
import { Operator } from "../apps/operator/src/operator";

/**
 * Runs a single operator cycle and reports what it decided.
 *
 * Useful for validating a strategy or budget change before letting a node run
 * unattended on that configuration.
 *
 *   npx tsx scripts/operator-tick.ts [--seed]
 *
 * `--seed` queues two throwaway jobs first — one inside the configured
 * mandate, one outside it — so the filtering is visible on an idle queue.
 */
async function main(): Promise<void> {
  const path = process.env["OPERATOR_CONFIG"] ?? "./apps/operator/operator.yaml";
  const config = await loadOperatorConfig(path);

  console.log(`operator   ${config.name}`);
  console.log(`domains    ${config.strategy.domains.join(", ") || "(any)"}`);
  console.log(`cadence    ${config.strategy.cadence} · max ${config.strategy.maxConcurrentJobs} concurrent`);
  console.log(`budget     ${config.budget.daily}/day · ${config.budget.perJob}/job · ${config.budget.transactionReserve} reserved for settlement\n`);

  const quiet: Logger = {
    info: () => {},
    warn: (message, detail) => console.log(`  ! ${message}`, detail ?? ""),
    error: (message, detail) => console.error(`  ✗ ${message}`, detail ?? ""),
  };

  const ctx = createContext({ logger: quiet });
  const operator = new Operator(ctx, config);
  await operator.register();

  const seeded: Array<{ id: string; label: string }> = [];
  if (process.argv.includes("--seed")) {
    const create = async (capabilities: string[], query: string, label: string) => {
      const job = await prisma.job.create({
        data: {
          type: "asset-analysis",
          query,
          requiredCapabilities: capabilities,
          requiredAgents: 2,
          budget: (2).toFixed(6),
          minimumConfidence: 0.3,
          status: "QUEUED",
          deadline: new Date(Date.now() + 5 * 60 * 1000),
          events: { create: { to: "QUEUED", reason: "seeded by operator-tick" } },
        },
        select: { id: true },
      });
      seeded.push({ id: job.id, label });
    };

    await create(["defi"], "Assess curated DeFi liquidity signal reliability for an allocator", "in mandate");
    await create(["robotics"], "Assess curated robotics telemetry annotation quality", "outside mandate");
    console.log(`seeded ${seeded.length} job(s)\n`);
  }

  const result = await operator.tick();

  console.log("tick result");
  console.log(`  discovered      ${result.discovered}`);
  console.log(`  accepted        ${result.accepted}`);
  console.log(`  executed        ${result.executed}`);
  console.log(`  failed          ${result.failed}`);
  console.log(`  budget declined ${result.budgetBlocked}`);
  for (const [reason, count] of Object.entries(result.skipped)) {
    console.log(`  skipped ${reason.padEnd(22)} ${count}`);
  }

  if (seeded.length > 0) {
    console.log("\nseeded job outcomes");
    for (const entry of seeded) {
      const job = await prisma.job.findUnique({
        where: { id: entry.id },
        select: { status: true },
      });
      console.log(`  ${entry.label.padEnd(16)} ${job?.status}`);
    }
  }

  operator.stop();
  await ctx.queue.close();
  await disconnect();
}

main().catch((error: unknown) => {
  console.error("operator tick failed:", error instanceof Error ? error.message : error);
  void disconnect();
  process.exitCode = 1;
});
