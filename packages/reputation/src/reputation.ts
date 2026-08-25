import { brierScore, NEUTRAL_REPUTATION, type ReputationVector } from "@averis/types";

/** One measurable thing an agent did, from which reputation is derived. */
export type Observation =
  | {
      kind: "evaluation";
      /** Deterministic evaluation of one submitted output. */
      evidenceQuality: number;
      internalConsistency: number;
      overall: number;
      domain: string | null;
      at: Date;
    }
  | {
      kind: "prediction";
      /** The confidence the agent stated when it made the claim. */
      confidence: number;
      outcomeWasTrue: boolean;
      domain: string | null;
      at: Date;
    }
  | {
      kind: "consensus";
      /** Share of merged claims the agent aligned with, 0..1. */
      agreement: number;
      domain: string | null;
      at: Date;
    };

export interface ReputationConfig {
  /**
   * Strength of the neutral prior, in observations.
   *
   * This is the anti-gaming parameter. At k=10, an agent with three lucky
   * calls sits at ~0.6, not 1.0 — so reputation cannot be manufactured by
   * spraying cheap high-confidence claims and cherry-picking the hits.
   */
  priorStrength?: number;
  /** Half-life in days. Old performance decays; nobody coasts on history. */
  halfLifeDays?: number;
  weights?: {
    accuracy?: number;
    calibration?: number;
    consistency?: number;
    evidenceQuality?: number;
  };
}

export interface ReputationUpdate {
  vector: ReputationVector;
  /** Per-dimension inputs, so a score can always be explained. */
  detail: Record<string, number>;
}

/**
 * Multidimensional, performance-based reputation.
 *
 * Four properties are deliberate:
 *
 *  1. **No capital input.** Stake is not an argument to this function. Economic
 *     stake may become a separate signal later, but it must never be able to
 *     substitute for measured performance.
 *  2. **Shrinkage toward neutral.** A small sample cannot produce an extreme
 *     score, so a fresh agent is neither trusted nor written off prematurely.
 *  3. **Calibration is scored separately from accuracy.** An agent that is
 *     right 90% of the time while claiming 99% certainty is badly calibrated,
 *     and the consensus engine needs to know that independently.
 *  4. **Recency decay.** Observations lose weight on a half-life, so reputation
 *     tracks current behaviour rather than a lifetime average.
 */
export class ReputationEngine {
  private readonly priorStrength: number;
  private readonly halfLifeMs: number;
  private readonly weights: Required<NonNullable<ReputationConfig["weights"]>>;

  constructor(config: ReputationConfig = {}) {
    this.priorStrength = config.priorStrength ?? 10;
    this.halfLifeMs = (config.halfLifeDays ?? 90) * 24 * 60 * 60 * 1000;
    this.weights = {
      accuracy: config.weights?.accuracy ?? 0.35,
      calibration: config.weights?.calibration ?? 0.25,
      consistency: config.weights?.consistency ?? 0.15,
      evidenceQuality: config.weights?.evidenceQuality ?? 0.25,
    };
  }

  /**
   * Computes a reputation vector from an agent's full observation history.
   *
   * Recomputing from history rather than mutating a running score means any
   * snapshot can be reproduced and audited, and a scoring-rule change can be
   * back-applied instead of corrupting existing state.
   */
  compute(observations: Observation[], now: Date = new Date()): ReputationUpdate {
    if (observations.length === 0) {
      return { vector: { ...NEUTRAL_REPUTATION }, detail: { sampleSize: 0 } };
    }

    const weightOf = (at: Date): number => {
      const age = Math.max(0, now.getTime() - at.getTime());
      return Math.pow(0.5, age / this.halfLifeMs);
    };

    const predictions = observations.filter((o) => o.kind === "prediction");
    const evaluations = observations.filter((o) => o.kind === "evaluation");
    const consensus = observations.filter((o) => o.kind === "consensus");

    // ── Accuracy: share of resolved predictions that came true ──────────────
    const accuracyRaw = weightedMean(
      predictions.map((p) => ({ value: p.outcomeWasTrue ? 1 : 0, weight: weightOf(p.at) })),
    );
    const accuracy = this.shrink(accuracyRaw.mean, accuracyRaw.count);

    // ── Calibration: Brier score mapped onto [0,1] ──────────────────────────
    // Brier 0 → 1.0 (perfect), 0.25 → 0.5 (a coin flip stated at 50%),
    // ≥0.5 → 0. Squared error is what makes overconfidence cost more than
    // being wrong while appropriately uncertain.
    const brierRaw = weightedMean(
      predictions.map((p) => ({
        value: brierScore(p.confidence, p.outcomeWasTrue),
        weight: weightOf(p.at),
      })),
    );
    const calibration = this.shrink(clamp01(1 - 2 * brierRaw.mean), brierRaw.count);

    // ── Evidence quality: from deterministic evaluation ─────────────────────
    const evidenceRaw = weightedMean(
      evaluations.map((e) => ({ value: e.evidenceQuality, weight: weightOf(e.at) })),
    );
    const evidenceQuality = this.shrink(evidenceRaw.mean, evidenceRaw.count);

    // ── Consistency: internal coherence and cohort stability ────────────────
    // Blends self-consistency with how *stably* the agent tracks the cohort.
    // High variance in cohort agreement means erratic behaviour, which is
    // distinct from being consistently contrarian.
    const internalRaw = weightedMean(
      evaluations.map((e) => ({ value: e.internalConsistency, weight: weightOf(e.at) })),
    );
    const agreementValues = consensus.map((c) => c.agreement);
    const stability = agreementValues.length >= 2 ? 1 - Math.min(1, 2 * stdev(agreementValues)) : 0.5;
    const consistency = this.shrink(
      internalRaw.count > 0 ? internalRaw.mean * 0.7 + stability * 0.3 : stability,
      internalRaw.count + consensus.length,
    );

    const overall = clamp01(
      accuracy * this.weights.accuracy +
        calibration * this.weights.calibration +
        consistency * this.weights.consistency +
        evidenceQuality * this.weights.evidenceQuality,
    );

    return {
      vector: {
        overall,
        accuracy,
        calibration,
        consistency,
        evidenceQuality,
        sampleSize: observations.length,
      },
      detail: {
        sampleSize: observations.length,
        resolvedPredictions: predictions.length,
        evaluations: evaluations.length,
        rawAccuracy: accuracyRaw.mean,
        meanBrier: brierRaw.mean,
        agreementStability: stability,
      },
    };
  }

  /** Per-domain vectors plus the overall vector, in one pass. */
  computeByDomain(
    observations: Observation[],
    now: Date = new Date(),
  ): { overall: ReputationUpdate; byDomain: Record<string, ReputationUpdate> } {
    const byDomain: Record<string, ReputationUpdate> = {};
    const domains = new Set(
      observations.map((o) => o.domain).filter((d): d is string => d !== null),
    );

    for (const domain of domains) {
      byDomain[domain] = this.compute(
        observations.filter((o) => o.domain === domain),
        now,
      );
    }

    return { overall: this.compute(observations, now), byDomain };
  }

  /**
   * Bayesian shrinkage toward the neutral prior. With no observations the
   * result is exactly neutral; it approaches the observed mean only as
   * evidence accumulates.
   */
  private shrink(observedMean: number, sampleSize: number): number {
    if (sampleSize <= 0) return 0.5;
    return clamp01(
      (0.5 * this.priorStrength + observedMean * sampleSize) / (this.priorStrength + sampleSize),
    );
  }
}

function weightedMean(rows: Array<{ value: number; weight: number }>): {
  mean: number;
  count: number;
} {
  if (rows.length === 0) return { mean: 0.5, count: 0 };
  const totalWeight = rows.reduce((acc, r) => acc + r.weight, 0);
  if (totalWeight <= 0) return { mean: 0.5, count: 0 };
  const mean = rows.reduce((acc, r) => acc + r.value * r.weight, 0) / totalWeight;
  return { mean, count: rows.length };
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
