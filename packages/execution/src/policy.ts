import { z } from "zod";

/**
 * Risk limits for one deployed automation. Every field is a hard ceiling
 * enforced *before* a position is opened, never a target discovered after.
 *
 * This is the trading counterpart of `@averis/budget`: the budget guard bounds
 * what the protocol may spend thinking, this bounds what an automation may put
 * at risk acting on what it thought.
 *
 * Note what is deliberately absent: a symbol allowlist. That is the right
 * primitive for equities and it does not survive contact with memecoins, where
 * every candidate is a mint that did not exist an hour ago. The gate moves
 * instead to the thing Averis can actually vouch for — a cohort verdict that
 * cleared confidence, consensus and cohort-size floors — plus a per-mint
 * cooldown and one position per mint. A blocklist is kept for known-bad mints,
 * but it is a mop, not a gate: it can only name what someone already found.
 */
export const TradePolicySchema = z.object({
  // ── Intelligence gate ────────────────────────────────────────────────────
  /**
   * Confidence and consensus are separate floors because the protocol reports
   * them separately, and for the same reason: a cohort can be confidently
   * split. Collapsing them into one threshold would let a job where every
   * agent disagreed loudly but certainly clear the bar.
   */
  minConfidence: z.number().min(0).max(1).default(0.65),
  minConsensus: z.number().min(0).max(1).default(0.6),
  /**
   * Agents that actually finished. Consensus is already scaled by corroboration
   * breadth, so a one-agent job scores 0 — but a floor here states the
   * requirement in the automation's own terms rather than relying on a
   * downstream discount to happen to be enough.
   */
  minAgents: z.number().int().min(1).max(10).default(3),
  /** A claim citing evidence the tool runtime never retrieved. */
  maxUnsupportedClaims: z.number().int().min(0).default(0),
  /**
   * Topics where the cohort genuinely split. Nonzero is allowed on purpose:
   * refusing every contested job would quietly select for the cohorts that
   * agree most, which is the correlated-error failure this protocol exists to
   * avoid. It is capped, not banned.
   */
  maxDisagreements: z.number().int().min(0).default(1),

  // ── Sizing ───────────────────────────────────────────────────────────────
  sizeUsd: z.number().positive().default(25),
  maxConcurrentPositions: z.number().int().min(1).default(3),
  maxDeployedUsd: z.number().positive().default(100),

  // ── Exit ─────────────────────────────────────────────────────────────────
  takeProfitPct: z.number().positive().default(60),
  stopLossPct: z.number().positive().default(25),
  /** Trailing stop arms only after the position is this far up. */
  trailingActivationPct: z.number().nonnegative().default(40),
  trailingStopPct: z.number().positive().default(20),
  /** A memecoin position with no exit rule left is a bag, not a trade. */
  maxHoldMinutes: z.number().int().positive().default(240),

  // ── Circuit breaker ──────────────────────────────────────────────────────
  maxConsecutiveLosses: z.number().int().min(1).default(3),
  maxDailyDrawdownUsd: z.number().positive().default(50),
  cooldownAfterLossMinutes: z.number().nonnegative().default(30),
  /**
   * One entry per mint per window. Without it a single trending token produces
   * several jobs in a row, each one honestly bullish, and the automation ends
   * up with its whole book in one name.
   */
  mintCooldownMinutes: z.number().nonnegative().default(60),
  blockedMints: z.array(z.string()).default([]),
});

export type TradePolicy = z.infer<typeof TradePolicySchema>;
export type TradePolicyInput = z.input<typeof TradePolicySchema>;

export const DEFAULT_TRADE_POLICY: TradePolicy = TradePolicySchema.parse({});

/**
 * Reads a policy that was persisted as JSON.
 *
 * Unparseable stored policy is a refusal, not a fallback to defaults: an
 * automation running the default limits when its owner configured tighter ones
 * is the failure mode that loses money quietly.
 */
export function parseStoredPolicy(value: unknown): TradePolicy {
  return TradePolicySchema.parse(value ?? {});
}
