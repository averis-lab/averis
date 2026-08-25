import { z } from "zod";

/**
 * Spend limits for one operator. Every field is a hard ceiling, not a target.
 */
export const BudgetPolicySchema = z.object({
  /** Rolling 24-hour ceiling, in USD. */
  daily: z.number().nonnegative().default(50),
  /** Rolling 7-day ceiling, in USD. */
  weekly: z.number().nonnegative().default(250),
  /** Ceiling for any single job, in USD. */
  perJob: z.number().nonnegative().default(5),
  /** Ceiling for any single agent run within a job, in USD. */
  perAgent: z.number().nonnegative().default(2),
  /**
   * Portion of the daily budget reserved for on-chain settlement, which cannot
   * be consumed by inference. Without this, a busy day of analysis can leave an
   * operator unable to pay out rewards it has already promised.
   */
  transactionReserve: z.number().nonnegative().default(5),
  currency: z.string().default("USD"),
});
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;
export type BudgetPolicyInput = z.input<typeof BudgetPolicySchema>;

export const DEFAULT_POLICY: BudgetPolicy = BudgetPolicySchema.parse({});

/** What the caller intends to spend, before it spends it. */
export interface SpendRequest {
  operatorId: string | null;
  jobId: string | null;
  agentId?: string | null;
  /** "llm" | "tool" | "settlement" */
  category: "llm" | "tool" | "settlement";
  /** Estimated cost in USD. Must be an upper bound, not a best guess. */
  estimatedUsd: number;
  detail?: Record<string, unknown>;
}

export type DenialReason =
  | "DAILY_LIMIT"
  | "WEEKLY_LIMIT"
  | "PER_JOB_LIMIT"
  | "PER_AGENT_LIMIT"
  | "TRANSACTION_RESERVE"
  | "INVALID_ESTIMATE";

export interface BudgetDecision {
  allowed: boolean;
  reason?: DenialReason;
  message?: string;
  /** How much headroom remains under the binding constraint. */
  remaining: number;
  /** Every limit evaluated, for auditability. */
  checks: Array<{ limit: DenialReason; ceiling: number; committed: number; wouldBe: number }>;
}

export class BudgetExceededError extends Error {
  constructor(readonly decision: BudgetDecision) {
    super(decision.message ?? "Budget exceeded");
    this.name = "BudgetExceededError";
  }
}
