import type { TradePolicy } from "./policy";

/**
 * Entry and exit rules, as pure functions.
 *
 * Nothing in this file imports a database, an RPC client or a clock it did not
 * receive as an argument — the same split `settlement-plan.ts` makes for
 * rewards, and for the same reason: every rule that decides whether money moves
 * has to be testable without money, a chain or a schema.
 */

/** What the protocol concluded, reduced to the fields an entry gate reads. */
export interface IntelligenceVerdict {
  jobId: string;
  mint: string;
  symbol: string;
  /** `recommendation.action`, verbatim from the merged result. */
  action: string;
  /** Merged confidence and consensus, never combined into one number. */
  confidence: number;
  consensus: number;
  /** Agents that actually finished, not the cohort that was requested. */
  agentsReporting: number;
  unsupportedClaims: number;
  disagreements: number;
}

export interface OpenPosition {
  id: string;
  mint: string;
  sizeUsd: number;
  entryPrice: number;
  /** Highest price observed since entry — the trailing stop's reference. */
  peakPrice: number;
  openedAt: Date;
}

export interface ClosedTrade {
  mint: string;
  pnlUsd: number;
  closedAt: Date;
}

export type EntryDenial =
  | "STOPPED"
  | "BREAKER_TRIPPED"
  | "LOSS_COOLDOWN"
  | "MINT_COOLDOWN"
  | "ALREADY_HOLDING"
  | "BLOCKED_MINT"
  | "MAX_POSITIONS"
  | "MAX_DEPLOYED"
  | "NOT_A_BUY"
  | "LOW_CONFIDENCE"
  | "LOW_CONSENSUS"
  | "THIN_COHORT"
  | "UNSUPPORTED_CLAIMS"
  | "CONTESTED";

export interface Gate {
  gate: EntryDenial;
  required: string;
  observed: string;
  passed: boolean;
}

export interface EntryDecision {
  open: boolean;
  /** The first binding denial, or null when every gate passed. */
  reason: EntryDenial | null;
  message: string;
  sizeUsd: number;
  /** Every gate evaluated, in order — so a refusal can be audited, not guessed at. */
  gates: Gate[];
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Actions that mean "take a position". Anything else is not a buy. */
const BUY_ACTIONS = new Set(["buy", "long", "enter", "accumulate"]);

export interface EntryInput {
  verdict: IntelligenceVerdict;
  policy: TradePolicy;
  active: boolean;
  openPositions: OpenPosition[];
  /** Closed trades used for the breaker and the cooldowns. */
  recentTrades: ClosedTrade[];
  /** When set, breaker derivation ignores everything closed before it. */
  breakerResetAt: Date | null;
  now: Date;
}

/**
 * Decides whether one intelligence verdict becomes one position.
 *
 * Every gate is evaluated even after one has already failed, because the list
 * is what the operator reads when asking why nothing traded today. Returning at
 * the first failure would answer "confidence too low" for a job that also had
 * no cohort and was already held — three different fixes, one of them shown.
 */
export function planEntry(input: EntryInput): EntryDecision {
  const { verdict, policy, active, openPositions, now } = input;

  const deployed = openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
  const breaker = deriveBreaker(input.recentTrades, policy, input.breakerResetAt, now);
  const lastLoss = lastLossAt(input.recentTrades, input.breakerResetAt);
  const lossCooldownRemaining = remainingMinutes(lastLoss, policy.cooldownAfterLossMinutes, now);
  const lastEntry = lastTradeOnMint(input.recentTrades, verdict.mint);
  const mintCooldownRemaining = remainingMinutes(lastEntry, policy.mintCooldownMinutes, now);

  const gates: Gate[] = [
    gate("STOPPED", "started", active ? "started" : "stopped", active),
    gate("BREAKER_TRIPPED", "not tripped", breaker.reason ?? "not tripped", !breaker.paused),
    gate(
      "LOSS_COOLDOWN",
      `${policy.cooldownAfterLossMinutes}m after a loss`,
      lossCooldownRemaining > 0 ? `${lossCooldownRemaining}m remaining` : "clear",
      lossCooldownRemaining === 0,
    ),
    gate(
      "MINT_COOLDOWN",
      `${policy.mintCooldownMinutes}m per mint`,
      mintCooldownRemaining > 0 ? `${mintCooldownRemaining}m remaining` : "clear",
      mintCooldownRemaining === 0,
    ),
    gate(
      "ALREADY_HOLDING",
      "no open position in this mint",
      openPositions.some((p) => p.mint === verdict.mint) ? "already holding" : "none",
      !openPositions.some((p) => p.mint === verdict.mint),
    ),
    gate(
      "BLOCKED_MINT",
      "not blocked",
      policy.blockedMints.includes(verdict.mint) ? "blocked" : "not blocked",
      !policy.blockedMints.includes(verdict.mint),
    ),
    gate(
      "MAX_POSITIONS",
      `≤ ${policy.maxConcurrentPositions}`,
      String(openPositions.length),
      openPositions.length < policy.maxConcurrentPositions,
    ),
    gate(
      "MAX_DEPLOYED",
      `≤ $${policy.maxDeployedUsd}`,
      `$${round(deployed + policy.sizeUsd)}`,
      deployed + policy.sizeUsd <= policy.maxDeployedUsd,
    ),
    gate(
      "NOT_A_BUY",
      "a buy recommendation",
      verdict.action || "none",
      BUY_ACTIONS.has(verdict.action.trim().toLowerCase()),
    ),
    gate(
      "LOW_CONFIDENCE",
      `≥ ${pct(policy.minConfidence)}`,
      pct(verdict.confidence),
      verdict.confidence >= policy.minConfidence,
    ),
    gate(
      "LOW_CONSENSUS",
      `≥ ${pct(policy.minConsensus)}`,
      pct(verdict.consensus),
      verdict.consensus >= policy.minConsensus,
    ),
    gate(
      "THIN_COHORT",
      `≥ ${policy.minAgents} agents`,
      `${verdict.agentsReporting} agents`,
      verdict.agentsReporting >= policy.minAgents,
    ),
    gate(
      "UNSUPPORTED_CLAIMS",
      `≤ ${policy.maxUnsupportedClaims}`,
      String(verdict.unsupportedClaims),
      verdict.unsupportedClaims <= policy.maxUnsupportedClaims,
    ),
    gate(
      "CONTESTED",
      `≤ ${policy.maxDisagreements} disagreements`,
      String(verdict.disagreements),
      verdict.disagreements <= policy.maxDisagreements,
    ),
  ];

  const failed = gates.find((g) => !g.passed);
  if (failed) {
    return {
      open: false,
      reason: failed.gate,
      message: `${failed.gate}: needed ${failed.required}, saw ${failed.observed}`,
      sizeUsd: 0,
      gates,
    };
  }

  return {
    open: true,
    reason: null,
    message: `${verdict.symbol} cleared every gate at ${pct(verdict.confidence)} confidence and ${pct(verdict.consensus)} consensus across ${verdict.agentsReporting} agents`,
    sizeUsd: policy.sizeUsd,
    gates,
  };
}

export type ExitReason = "TAKE_PROFIT" | "STOP_LOSS" | "TRAILING_STOP" | "MAX_HOLD";

export interface ExitDecision {
  close: boolean;
  reason: ExitReason | null;
  message: string;
  /** Peak carried forward, so the caller persists it without recomputing. */
  peakPrice: number;
  pnlPct: number;
}

/**
 * Decides whether an open position closes at the given price.
 *
 * Checked in severity order: a candle that trips both the stop and the take
 * profit is a loss, not a win. Assuming the favourable fill would make every
 * backtest of this policy optimistic in exactly the cases that matter.
 */
export function planExit(
  position: OpenPosition,
  price: number,
  policy: TradePolicy,
  now: Date,
): ExitDecision {
  const peakPrice = Math.max(position.peakPrice, price);
  const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
  const fromPeakPct = ((price - peakPrice) / peakPrice) * 100;
  const heldMinutes = (now.getTime() - position.openedAt.getTime()) / MINUTE_MS;
  const peakGainPct = ((peakPrice - position.entryPrice) / position.entryPrice) * 100;

  const decide = (reason: ExitReason, message: string): ExitDecision => ({
    close: true,
    reason,
    message,
    peakPrice,
    pnlPct,
  });

  if (pnlPct <= -policy.stopLossPct) {
    return decide("STOP_LOSS", `down ${pnlPct.toFixed(1)}%, stop at −${policy.stopLossPct}%`);
  }
  if (peakGainPct >= policy.trailingActivationPct && fromPeakPct <= -policy.trailingStopPct) {
    return decide(
      "TRAILING_STOP",
      `${fromPeakPct.toFixed(1)}% off a peak of +${peakGainPct.toFixed(1)}%`,
    );
  }
  if (pnlPct >= policy.takeProfitPct) {
    return decide("TAKE_PROFIT", `up ${pnlPct.toFixed(1)}%, target +${policy.takeProfitPct}%`);
  }
  if (heldMinutes >= policy.maxHoldMinutes) {
    return decide(
      "MAX_HOLD",
      `held ${Math.round(heldMinutes)}m, limit ${policy.maxHoldMinutes}m`,
    );
  }

  return { close: false, reason: null, message: "holding", peakPrice, pnlPct };
}

export interface BreakerState {
  paused: boolean;
  reason: string | null;
  consecutiveLosses: number;
  dailyPnlUsd: number;
}

/**
 * Derives the circuit breaker from trade history rather than reading a stored
 * flag.
 *
 * This mirrors how reputation is handled: snapshots are recomputed from full
 * history instead of incremented, so a rule change applies retroactively and
 * any past decision can be replayed. A persisted `paused` boolean drifts from
 * the history that justified it, and there is then no way to tell which one is
 * wrong.
 *
 * The cost of deriving is that an automation whose first trades all lose trips
 * the breaker and can never trade its way out. `breakerResetAt` is the escape
 * hatch: it moves the window forward without deleting the trades that caused
 * the pause.
 */
export function deriveBreaker(
  trades: ClosedTrade[],
  policy: TradePolicy,
  breakerResetAt: Date | null,
  now: Date,
): BreakerState {
  const considered = trades
    .filter((t) => !breakerResetAt || t.closedAt > breakerResetAt)
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());

  let consecutiveLosses = 0;
  for (const trade of considered) {
    if (trade.pnlUsd >= 0) break;
    consecutiveLosses++;
  }

  const dayStart = new Date(now.getTime() - DAY_MS);
  const dailyPnlUsd = round(
    considered.filter((t) => t.closedAt >= dayStart).reduce((sum, t) => sum + t.pnlUsd, 0),
  );

  if (consecutiveLosses >= policy.maxConsecutiveLosses) {
    return {
      paused: true,
      reason: `${consecutiveLosses} consecutive losses (limit ${policy.maxConsecutiveLosses})`,
      consecutiveLosses,
      dailyPnlUsd,
    };
  }
  if (dailyPnlUsd <= -policy.maxDailyDrawdownUsd) {
    return {
      paused: true,
      reason: `daily drawdown $${Math.abs(dailyPnlUsd).toFixed(2)} exceeds $${policy.maxDailyDrawdownUsd}`,
      consecutiveLosses,
      dailyPnlUsd,
    };
  }

  return { paused: false, reason: null, consecutiveLosses, dailyPnlUsd };
}

function gate(name: EntryDenial, required: string, observed: string, passed: boolean): Gate {
  return { gate: name, required, observed, passed };
}

function lastLossAt(trades: ClosedTrade[], resetAt: Date | null): Date | null {
  const losses = trades
    .filter((t) => t.pnlUsd < 0 && (!resetAt || t.closedAt > resetAt))
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());
  return losses[0]?.closedAt ?? null;
}

function lastTradeOnMint(trades: ClosedTrade[], mint: string): Date | null {
  const onMint = trades
    .filter((t) => t.mint === mint)
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime());
  return onMint[0]?.closedAt ?? null;
}

function remainingMinutes(since: Date | null, windowMinutes: number, now: Date): number {
  if (!since || windowMinutes <= 0) return 0;
  const elapsed = (now.getTime() - since.getTime()) / MINUTE_MS;
  return elapsed >= windowMinutes ? 0 : Math.ceil(windowMinutes - elapsed);
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const round = (v: number): number => Math.round(v * 1e6) / 1e6;
