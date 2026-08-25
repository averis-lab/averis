import type { ConsensusInput } from "@averis/types";

export interface AgentWeight {
  outputId: string;
  agentId: string;
  /** Normalized across the cohort so weights sum to 1. */
  weight: number;
  /** Per-factor contributions, so any weight can be explained after the fact. */
  breakdown: Record<string, number>;
}

/**
 * How much each agent's voice counts.
 *
 * Kept behind an interface because this is the part of the protocol most
 * likely to change: weighting is where reputation, specialization and evidence
 * quality get traded off, and that tradeoff should be able to evolve without
 * a rewrite of the merge logic.
 */
export interface WeightingStrategy {
  readonly name: string;
  readonly config: Record<string, unknown>;
  weigh(inputs: ConsensusInput[]): AgentWeight[];
}

/**
 * Equal weight for every agent.
 *
 * Kept as a first-class strategy, not a placeholder: it is the control group.
 * Any claim that reputation weighting improves outcomes has to be measured
 * against this.
 */
export class UniformWeighting implements WeightingStrategy {
  readonly name = "uniform";
  readonly config = {};

  weigh(inputs: ConsensusInput[]): AgentWeight[] {
    const weight = inputs.length === 0 ? 0 : 1 / inputs.length;
    return inputs.map((input) => ({
      outputId: input.outputId,
      agentId: input.agentId,
      weight,
      breakdown: { uniform: 1 },
    }));
  }
}

export interface MultiFactorConfig {
  /** Relative importance of each signal. Need not sum to 1; they are normalized. */
  factors?: {
    domainReputation?: number;
    accuracy?: number;
    calibration?: number;
    evidenceQuality?: number;
    evaluation?: number;
    selfConfidence?: number;
  };
  /**
   * Ceiling on any single agent's share of the cohort. Without this a single
   * high-reputation agent can dominate a cohort and multi-agent analysis
   * degenerates into single-agent analysis with extra steps.
   */
  maxShare?: number;
  /**
   * Floor on any agent's share, so a newcomer is never weighted to zero and
   * can still accumulate a track record.
   */
  minShare?: number;
}

/**
 * The default strategy: a normalized linear blend of performance signals.
 *
 * Two deliberate choices:
 *  * Self-reported confidence carries the *smallest* weight. It is the one
 *    signal an agent can inflate for free, so it must never be the main driver.
 *  * Domain reputation outranks overall reputation. A job asking about DeFi
 *    liquidity should not be decided by an agent whose record is strong at
 *    robotics — which is the failure mode of naive "pick the highest overall
 *    reputation" selection.
 */
export class MultiFactorWeighting implements WeightingStrategy {
  readonly name = "multi-factor-v1";
  readonly config: Record<string, unknown>;

  private readonly factors: Required<NonNullable<MultiFactorConfig["factors"]>>;
  private readonly maxShare: number;
  private readonly minShare: number;

  constructor(config: MultiFactorConfig = {}) {
    this.factors = {
      domainReputation: config.factors?.domainReputation ?? 0.3,
      accuracy: config.factors?.accuracy ?? 0.2,
      calibration: config.factors?.calibration ?? 0.15,
      evidenceQuality: config.factors?.evidenceQuality ?? 0.2,
      evaluation: config.factors?.evaluation ?? 0.1,
      selfConfidence: config.factors?.selfConfidence ?? 0.05,
    };
    this.maxShare = config.maxShare ?? 0.5;
    this.minShare = config.minShare ?? 0.05;
    this.config = { factors: this.factors, maxShare: this.maxShare, minShare: this.minShare };
  }

  weigh(inputs: ConsensusInput[]): AgentWeight[] {
    if (inputs.length === 0) return [];
    if (inputs.length === 1) {
      const only = inputs[0]!;
      return [
        {
          outputId: only.outputId,
          agentId: only.agentId,
          weight: 1,
          breakdown: { soleAgent: 1 },
        },
      ];
    }

    const raw = inputs.map((input) => {
      const s = input.signals;
      // Fall back to overall reputation when the agent has no record in this
      // domain yet, rather than treating "no data" as "bad".
      const domain = s.domainReputation > 0 ? s.domainReputation : s.reputation;

      const breakdown: Record<string, number> = {
        domainReputation: domain * this.factors.domainReputation,
        accuracy: s.accuracy * this.factors.accuracy,
        calibration: s.calibration * this.factors.calibration,
        evidenceQuality: s.evidenceQuality * this.factors.evidenceQuality,
        // An unevaluated output falls back to neutral, never to zero.
        evaluation: (s.evaluation ?? 0.5) * this.factors.evaluation,
        selfConfidence: input.confidence * this.factors.selfConfidence,
      };

      const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
      return { input, breakdown, score: Math.max(score, 1e-6) };
    });

    const total = raw.reduce((acc, r) => acc + r.score, 0);
    let shares = raw.map((r) => ({ ...r, share: r.score / total }));

    shares = clampShares(shares, this.minShare, this.maxShare);

    return shares.map((r) => ({
      outputId: r.input.outputId,
      agentId: r.input.agentId,
      weight: r.share,
      breakdown: { ...r.breakdown, rawScore: r.score },
    }));
  }
}

/**
 * Applies the floor and ceiling, then redistributes the difference across the
 * agents that are not pinned, so the result still sums to 1.
 */
function clampShares<T extends { share: number }>(rows: T[], min: number, max: number): T[] {
  const feasibleMin = Math.min(min, 1 / rows.length);
  const feasibleMax = Math.max(max, 1 / rows.length);

  let result = rows.map((r) => ({ ...r }));

  for (let pass = 0; pass < 8; pass++) {
    const pinned: boolean[] = result.map(
      (r) => r.share <= feasibleMin + 1e-9 || r.share >= feasibleMax - 1e-9,
    );
    let changed = false;

    result = result.map((r, i) => {
      const clamped = Math.min(feasibleMax, Math.max(feasibleMin, r.share));
      if (Math.abs(clamped - r.share) > 1e-9) changed = true;
      pinned[i] = clamped !== r.share ? true : pinned[i]!;
      return { ...r, share: clamped };
    });

    const total = result.reduce((acc, r) => acc + r.share, 0);
    const drift = 1 - total;
    if (Math.abs(drift) < 1e-9) return result;

    const free = result.filter((_, i) => !pinned[i]);
    const freeTotal = free.reduce((acc, r) => acc + r.share, 0);

    if (free.length === 0 || freeTotal <= 0) {
      // Everything is pinned; scale uniformly to restore the sum.
      return result.map((r) => ({ ...r, share: r.share / total }));
    }

    result = result.map((r, i) =>
      pinned[i] ? r : { ...r, share: r.share + drift * (r.share / freeTotal) },
    );

    if (!changed) break;
  }

  const total = result.reduce((acc, r) => acc + r.share, 0);
  return result.map((r) => ({ ...r, share: r.share / total }));
}
