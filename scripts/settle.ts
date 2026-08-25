import "@averis/db/env";
import { disconnect, prisma } from "@averis/db";
import {
  SettlementEngine,
  addressBookFrom,
  createSettlementDriver,
  type SettlementReport,
} from "@averis/protocol";

/**
 * Settles what the protocol owes.
 *
 * Printing the plan is the default and paying requires `--execute`, because
 * every other operation in this repository can be run again and this one
 * cannot. The same reason the driver defaults to `none`: an operator should
 * have to say twice that they mean to move money.
 *
 *   npm run settle                        # plan for everything outstanding
 *   npm run settle -- --job <id>          # plan for one job
 *   npm run settle -- --execute           # actually pay
 */

interface Args {
  execute: boolean;
  jobId?: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { execute: false, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--execute") args.execute = true;
    else if (flag === "--job") args.jobId = argv[++i];
    else if (flag === "--limit") args.limit = Math.max(1, Number(argv[++i]) || 50);
  }
  return args;
}

const usd = (value: number) => `$${value.toFixed(6)}`;

function printReport(report: SettlementReport): void {
  if (report.settled.length > 0) {
    console.log(`\nSettled (${report.settled.length}):`);
    for (const row of report.settled) {
      console.log(
        `  ✓ ${usd(row.amount).padStart(12)}  →  ${row.payee}  ${row.status}  ${row.reference}`,
      );
    }
  }
  if (report.failed.length > 0) {
    console.log(`\nFailed (${report.failed.length}):`);
    for (const row of report.failed) console.log(`  ✗ ${row.rewardId}  ${row.error}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const driver = createSettlementDriver();
  const engine = new SettlementEngine({ driver, addresses: addressBookFrom() });

  const outstanding = await prisma.reward.count({
    where: { status: "PENDING", ...(args.jobId ? { jobId: args.jobId } : {}) },
  });

  console.log(`\ndriver: ${driver.name}   outstanding rewards: ${outstanding}`);

  const plan = await engine.plan(args.limit, args.jobId);
  const total = plan.instructions.reduce((sum, i) => sum + i.amount, 0);

  console.log(`\nWould pay ${plan.instructions.length} of ${outstanding} (${usd(total)}):`);
  for (const instruction of plan.instructions) {
    console.log(
      `  ${instruction.role.padEnd(9)} ${usd(instruction.amount).padStart(12)}  →  ${instruction.payee}`,
    );
  }

  if (plan.skips.length > 0) {
    console.log(`\nHeld back (${plan.skips.length}):`);
    for (const skip of plan.skips) console.log(`  · ${skip.rewardId}  ${skip.reason}`);
  }

  if (!args.execute) {
    console.log("\nThis was a plan. Re-run with --execute to pay.\n");
    return;
  }

  if (plan.instructions.length === 0) {
    console.log("\nNothing to pay.\n");
    return;
  }

  console.log(`\nPaying with driver "${driver.name}"…`);
  printReport(await engine.sweep(args.limit, args.jobId));
  console.log();
}

/**
 * Postgres being down is an instruction, not a stack trace.
 *
 * The reason can arrive in any of three places: a Prisma error code, the
 * message, or the adapter's nested cause — and when the connection is refused
 * outright the message is empty, so reading only that prints nothing at all.
 */
function explain(error: unknown): string {
  const { code, meta } = error as { code?: string; meta?: unknown };
  const message = error instanceof Error ? error.message.trim() : String(error);
  const signals = [code ?? "", message, JSON.stringify(meta ?? "")].join(" ");

  if (/P1001|ECONNREFUSED|DatabaseNotReachable|not reachable|Can't reach database/i.test(signals)) {
    return "Postgres is not reachable. Run `npm run infra:up` first.";
  }
  return message || code || "unknown error";
}

main()
  .catch((error: unknown) => {
    console.error("\nsettlement failed:", explain(error));
    process.exitCode = 1;
  })
  .finally(() => disconnect());
