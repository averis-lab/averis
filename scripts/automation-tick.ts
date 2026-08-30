import "@averis/db/env";
import { disconnect, prisma } from "@averis/db";
import { AutomationEngine, resolveDriver, resolvePriceSource } from "@averis/execution";

/**
 * Runs one automation cycle: sweep exits, then consider new intelligence.
 *
 * The automation surface was autonomous in shape only. `evaluate` decided
 * whether one named job cleared the policy, and the only way to name a job was
 * an HTTP call — so a human picked every verdict the automation ever saw. This
 * is the part that was missing: something that finds the jobs on its own.
 *
 *   npx tsx scripts/automation-tick.ts [--automation <id>] [--dry]
 *
 * `--dry` reports what it would consider and touches nothing, which is how you
 * check a policy change before it can open anything.
 *
 * Two ordering decisions are deliberate.
 *
 * Exits are swept *before* entries. A position that should already have closed
 * is still holding a slot against `maxConcurrentPositions`, and considering
 * entries first would refuse a good verdict to protect a position the policy
 * had already decided to exit.
 *
 * A job is considered once. Candidates exclude anything this automation has
 * already recorded an event for, so a refusal stays refused instead of being
 * re-decided — and re-logged — on every tick. The intelligence did not change;
 * only the clock did.
 */
async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  // Guarded, because `indexOf` returns -1 when the flag is absent and
  // `argv[-1 + 1]` is the node binary — a truthy string that would be looked
  // up as an automation id and quietly match nothing.
  const flag = process.argv.indexOf("--automation");
  const only = flag >= 0 ? process.argv[flag + 1] : undefined;

  const driver = resolveDriver(process.env["EXECUTION_DRIVER"]);
  const prices = resolvePriceSource(process.env);
  const engine = new AutomationEngine(driver, prices);

  console.log(`driver     ${driver.name} (${driver.spendsRealMoney ? "SPENDS REAL MONEY" : "no real money"})`);
  console.log(`prices     ${prices.name}${dry ? "\nmode       dry run — nothing will be written" : ""}\n`);

  const automations = await prisma.automation.findMany({
    where: only ? { id: only } : { active: true },
  });

  if (automations.length === 0) {
    console.log("No active automation to tick. Deploy one first, or pass --automation <id>.");
    return;
  }

  for (const automation of automations) {
    console.log(`── ${automation.name}  [${automation.mode}${automation.active ? "" : ", stopped"}]`);

    // Exits first; see the note above.
    if (!dry) {
      const swept = await engine.sweepExits(automation.id);
      console.log(`   exits    checked ${swept.checked} · closed ${swept.closed} · unpriced ${swept.unpriced}`);
    }

    // Everything the protocol has resolved that names something tradable and
    // that this automation has not already ruled on.
    const seen = await prisma.automationEvent.findMany({
      where: { automationId: automation.id, jobId: { not: null } },
      select: { jobId: true },
      distinct: ["jobId"],
    });

    const candidates = await prisma.job.findMany({
      where: {
        status: "RESOLVED",
        target: { not: null },
        id: { notIn: seen.map((row) => row.jobId!).filter(Boolean) },
      },
      select: { id: true, target: true, type: true },
      orderBy: { createdAt: "desc" },
    });

    console.log(`   verdicts ${candidates.length} unconsidered`);

    let opened = 0;
    for (const job of candidates) {
      if (dry) {
        console.log(`     would consider ${job.id}  ${job.type} → ${job.target}`);
        continue;
      }

      const { decision, positionId } = await engine.evaluate(automation.id, job.id);
      if (decision.open) {
        opened += 1;
        console.log(`     OPEN    ${job.target}  $${decision.sizeUsd}  position ${positionId}`);
      } else {
        // The failing gate, not just the verdict: "why not" is the question an
        // owner actually has, and the plan already answers it.
        const failed = decision.gates.filter((gate) => !gate.passed);
        const why = failed.length > 0
          ? failed.map((gate) => `${gate.gate}: wanted ${gate.required}, got ${gate.observed}`).join(" · ")
          : decision.message;
        console.log(`     refuse  ${job.target}  ${decision.reason}  ${why}`);
      }
    }

    if (!dry) console.log(`   opened   ${opened} of ${candidates.length}\n`);
  }
}

main()
  .catch((error: unknown) => {
    console.error("automation tick failed:", error);
    process.exitCode = 1;
  })
  .finally(() => disconnect());
