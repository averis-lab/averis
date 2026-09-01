/**
 * Outbound settlement — the decision half.
 *
 * The reward stage decides *what* is owed; this decides *whether it may be
 * paid, to whom, and exactly once*. The two are separate on purpose: splitting
 * a budget is arithmetic that can be replayed, while paying is an irreversible
 * side effect that must not be replayed at all.
 *
 * Three properties carry the design:
 *
 *  1. **A reward is paid at most once.** Enforced in `settlement.ts`, where a
 *     conditional claim and a unique constraint on the transaction row make a
 *     second payment impossible rather than merely unlikely.
 *  2. **Deciding is separable from paying.** This file holds only the rules:
 *     given rows and an address book, `planSettlement` returns what would be
 *     paid and why the rest would not. It imports no database and opens no
 *     connection — the on-chain driver it names loads its chain library lazily,
 *     so this stays true — which is what lets every rule below be tested
 *     without a chain, a database, or money. `settlement.ts` carries a plan
 *     out.
 *  3. **Nothing pays out more than the job's budget.** The split is already
 *     normalised upstream; this checks it again at the point of no return,
 *     because a bug that overpays is not recoverable by rolling back a row.
 */

import { EvmSettlementDriver, evmSettlementConfigFrom } from "./settlement-evm";

export type RewardRole = "AGENT" | "VALIDATOR" | "PROTOCOL" | "TREASURY";

/** The smallest amount USDC can represent; below this there is nothing to send. */
export const DUST = 0.000001;

/** Tolerance for the budget check — float arithmetic on a normalised split. */
const BUDGET_EPSILON = 0.000001;

export interface PlannableReward {
  id: string;
  jobId: string;
  role: RewardRole;
  status: string;
  amount: number;
  currency: string;
  agentId: string | null;
  /** Wallet the agent's owner registered, when there is one. */
  agentPayee: string | null;
}

/** Where non-agent roles are paid, from configuration. */
export interface AddressBook {
  VALIDATOR?: string | null;
  PROTOCOL?: string | null;
  TREASURY?: string | null;
}

export interface SettlementInstruction {
  rewardId: string;
  jobId: string;
  role: RewardRole;
  payee: string;
  amount: number;
  currency: string;
}

export interface SettlementSkip {
  rewardId: string;
  reason: string;
}

export interface SettlementPlan {
  instructions: SettlementInstruction[];
  skips: SettlementSkip[];
}

export interface PlanOptions {
  /** Job budgets, used for the overspend check. Missing means unchecked. */
  budgets?: Record<string, number>;
  /**
   * The driver's own test for an address it could pay. Missing means unchecked.
   *
   * Asked here rather than in the driver so an unpayable address is a skip with
   * a reason, visible in `npm run settle` before anything is executed, instead
   * of a failure discovered partway through a sweep that has already paid some
   * of the split.
   */
  acceptsPayee?: (payee: string) => boolean;
}

/**
 * Decides what would be paid. Pure: no database, no network, no money.
 *
 * Everything it refuses, it refuses with a reason attached to the reward, so a
 * sweep that pays nothing can still say why for every row rather than
 * reporting an empty result and leaving the operator to guess.
 */
export function planSettlement(
  rewards: PlannableReward[],
  addresses: AddressBook = {},
  options: PlanOptions = {},
): SettlementPlan {
  const instructions: SettlementInstruction[] = [];
  const skips: SettlementSkip[] = [];

  // The overspend check is per job and has to see the whole job at once, so it
  // runs before any row is turned into an instruction.
  const owedByJob = new Map<string, number>();
  for (const reward of rewards) {
    owedByJob.set(reward.jobId, (owedByJob.get(reward.jobId) ?? 0) + Math.max(0, reward.amount));
  }

  const overspent = new Set<string>();
  for (const [jobId, owed] of owedByJob) {
    const budget = options.budgets?.[jobId];
    if (budget !== undefined && owed > budget + BUDGET_EPSILON) overspent.add(jobId);
  }

  for (const reward of rewards) {
    if (reward.status !== "PENDING") {
      skips.push({ rewardId: reward.id, reason: `not payable in state ${reward.status}` });
      continue;
    }

    if (overspent.has(reward.jobId)) {
      // The whole job is held, not just the row that tipped it over: paying
      // part of a split that does not add up is worse than paying none of it.
      skips.push({
        rewardId: reward.id,
        reason: `job ${reward.jobId} owes more than its budget — settlement held`,
      });
      continue;
    }

    if (!(reward.amount > 0)) {
      skips.push({ rewardId: reward.id, reason: "amount is zero" });
      continue;
    }

    if (reward.amount < DUST) {
      skips.push({ rewardId: reward.id, reason: `amount is below ${DUST} ${reward.currency}` });
      continue;
    }

    const payee =
      reward.role === "AGENT" ? reward.agentPayee : (addresses[reward.role] ?? null);

    if (!payee) {
      skips.push({
        rewardId: reward.id,
        reason:
          reward.role === "AGENT"
            ? `agent ${reward.agentId ?? "?"} has no payout address`
            : `no address configured for ${reward.role}`,
      });
      continue;
    }

    if (options.acceptsPayee && !options.acceptsPayee(payee)) {
      // The inbound paywall validates the address it is paid to; until now
      // nothing validated the addresses paid out. An agent whose owner
      // connected a wallet on another chain lands here.
      skips.push({
        rewardId: reward.id,
        reason:
          reward.role === "AGENT"
            ? `agent ${reward.agentId ?? "?"} has a payout address this driver cannot pay: ${payee}`
            : `the address configured for ${reward.role} is not one this driver can pay: ${payee}`,
      });
      continue;
    }

    instructions.push({
      rewardId: reward.id,
      jobId: reward.jobId,
      role: reward.role,
      payee,
      amount: reward.amount,
      currency: reward.currency,
    });
  }

  return { instructions, skips };
}

export interface SettlementReceipt {
  /** Chain signature, or another reference that identifies this payment. */
  reference: string;
  status: "BROADCAST" | "CONFIRMED";
  detail?: Record<string, unknown>;
}

export interface SettlementDriver {
  readonly name: string;
  /**
   * Whether this driver could pay this address at all.
   *
   * Optional: a driver that does not implement it accepts anything, which is
   * right for `ledger`, where the payee is a note about a payment made
   * somewhere else rather than an address anything will be sent to.
   */
  acceptsPayee?(payee: string): boolean;
  settle(instruction: SettlementInstruction): Promise<SettlementReceipt>;
}

/**
 * The default. Refuses loudly rather than pretending to pay.
 *
 * A no-op driver that reported success would mark rewards SETTLED and destroy
 * the record that they are still owed — the one outcome worse than not paying.
 */
export class NoSettlementDriver implements SettlementDriver {
  readonly name = "none";

  async settle(): Promise<SettlementReceipt> {
    throw new Error(
      "SETTLEMENT_DRIVER is 'none'; no payment was attempted. Set it to 'ledger' to record " +
        "payments made outside this system.",
    );
  }
}

/**
 * Records a payment that happened somewhere else.
 *
 * This is not a simulation and not a fake chain: it means an operator paid by
 * whatever means they use, and the protocol is recording that fact against the
 * reward so the amount is not owed twice. The reference is derived from the
 * reward id, so replaying a sweep produces the same reference rather than a
 * second, different-looking payment.
 */
export class LedgerSettlementDriver implements SettlementDriver {
  readonly name = "ledger";

  async settle(instruction: SettlementInstruction): Promise<SettlementReceipt> {
    return {
      reference: `ledger:${instruction.rewardId}`,
      status: "CONFIRMED",
      detail: { payee: instruction.payee, amount: instruction.amount, offChain: true },
    };
  }
}

/**
 * Builds the driver named by the environment.
 *
 * The default is still `none`, and moving money still takes two deliberate
 * acts: naming a driver here, and passing `--execute` to the sweep. A chain
 * name is not a driver name — `SETTLEMENT_DRIVER=robinhood` fails, because the
 * chain is chosen by `SETTLEMENT_CHAIN_ID` and the driver only says how to
 * reach it.
 */
export function createSettlementDriver(
  env: NodeJS.ProcessEnv = process.env,
): SettlementDriver {
  const name = (env["SETTLEMENT_DRIVER"] ?? "none").trim().toLowerCase();

  switch (name) {
    case "evm":
      return new EvmSettlementDriver(evmSettlementConfigFrom(env));
    case "ledger":
      return new LedgerSettlementDriver();
    case "none":
    case "":
      return new NoSettlementDriver();
    default:
      throw new Error(
        `Unknown SETTLEMENT_DRIVER "${name}". Supported: none, ledger, evm. An EVM chain is ` +
          "selected with SETTLEMENT_CHAIN_ID, not by naming it here — see docs/protocol.md.",
      );
  }
}

export function addressBookFrom(env: NodeJS.ProcessEnv = process.env): AddressBook {
  return {
    VALIDATOR: env["SETTLEMENT_VALIDATOR_ADDRESS"] ?? null,
    PROTOCOL: env["SETTLEMENT_PROTOCOL_ADDRESS"] ?? null,
    TREASURY: env["SETTLEMENT_TREASURY_ADDRESS"] ?? null,
  };
}
