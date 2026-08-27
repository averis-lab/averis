import "@averis/db/env";
import { disconnect, prisma } from "@averis/db";
import { ResolutionStage, createContext, createOracles } from "@averis/protocol";
import type { PendingPrediction, ResolutionOracle } from "@averis/types";

/**
 * Runs the prediction sweep by hand.
 *
 * The workers already sweep on a timer, so this exists for the two things a
 * timer cannot do: show an operator what is outstanding and which oracle would
 * answer for it, and close the loop on demand rather than at the next tick.
 *
 * Inspecting is the default and resolving requires `--execute`, for the same
 * reason `settle` is built that way. Resolution is close to irreversible: a
 * prediction that settles TRUE, FALSE or UNRESOLVABLE is written into an
 * agent's permanent track record, and marking one against the wrong oracle is
 * not undone by running the command again.
 *
 *   npm run resolve                     # what is due, and what would answer
 *   npm run resolve -- --all            # include predictions not yet due
 *   npm run resolve -- --execute        # actually resolve everything due
 */

interface Args {
  execute: boolean;
  all: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, all: false, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--execute") args.execute = true;
    else if (flag === "--all") args.all = true;
    else if (flag === "--limit") args.limit = Math.max(1, Number(argv[++i]) || 50);
  }
  return args;
}

/** Which registered oracle would take this prediction, if any. */
function answeredBy(oracles: ResolutionOracle[], source: string): string {
  return oracles.find((o) => o.supports(source))?.name ?? "— none";
}

const ago = (deadline: Date, now: Date): string => {
  const hours = (now.getTime() - deadline.getTime()) / 3_600_000;
  const magnitude = Math.abs(hours);
  const unit = magnitude >= 48 ? `${(magnitude / 24).toFixed(1)}d` : `${magnitude.toFixed(1)}h`;
  return hours >= 0 ? `${unit} overdue` : `in ${unit}`;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const ctx = createContext();
  const oracles = createOracles(ctx);

  console.log(`Oracles registered: ${oracles.map((o) => o.name).join(", ")}`);

  const pending = await prisma.prediction.findMany({
    where: { outcome: "PENDING", ...(args.all ? {} : { deadline: { lte: now } }) },
    orderBy: { deadline: "asc" },
    take: args.limit,
    select: { id: true, statement: true, confidence: true, criteria: true, deadline: true },
  });

  if (pending.length === 0) {
    console.log(
      args.all
        ? "\nNo pending predictions at all."
        : "\nNothing is due. Run with --all to see predictions still ahead of their deadline.",
    );
    return;
  }

  console.log(`\n${args.all ? "Pending" : "Due"} (${pending.length}):`);
  for (const row of pending) {
    const criteria = row.criteria as PendingPrediction["criteria"];
    console.log(
      `  ${row.deadline.toISOString()}  ${ago(row.deadline, now).padEnd(14)}` +
        `  ${answeredBy(oracles, criteria.source ?? "").padEnd(14)}` +
        `  ${criteria.source} ${criteria.metric} ${criteria.operator} ${criteria.threshold}`,
    );
    console.log(`      p=${row.confidence.toFixed(2)}  ${row.statement.slice(0, 88)}`);
  }

  // Counted over what is actually due: an oracle missing for a prediction
  // three days out is a gap there is still time to close.
  const due = pending.filter((row) => row.deadline <= now);
  const orphaned = due.filter(
    (row) => answeredBy(oracles, (row.criteria as PendingPrediction["criteria"]).source ?? "") === "— none",
  ).length;
  if (orphaned > 0) {
    console.log(
      `\n${orphaned} due prediction(s) have no registered oracle and would settle UNRESOLVABLE.` +
        `\nSee the resolution-oracle block in .env.example before running with --execute.`,
    );
  }

  if (!args.execute) {
    console.log(`\nInspection only. Re-run with --execute to resolve the ${due.length} due.`);
    return;
  }

  const result = await new ResolutionStage(ctx, oracles).run(now);
  console.log(
    `\nresolved ${result.resolved}` +
      `  unresolvable ${result.unresolvable}` +
      `  deferred ${result.deferred} (oracle unreachable; stays pending for the next sweep)`,
  );

  if (result.resolved > 0) {
    const settled = await prisma.predictionResolution.findMany({
      orderBy: { resolvedAt: "desc" },
      take: result.resolved,
      select: { outcome: true, observedValue: true, resolvedBy: true, brierScore: true },
    });
    console.log("\nJust settled:");
    for (const row of settled) {
      const observed = (row.observedValue as { value?: unknown } | null)?.value;
      console.log(
        `  ${row.outcome.padEnd(13)} observed=${String(observed ?? "—").padEnd(16)}` +
          `  by ${row.resolvedBy.padEnd(20)}` +
          `  brier=${row.brierScore === null ? "—" : row.brierScore.toFixed(4)}`,
      );
    }
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(disconnect);
