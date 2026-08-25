import type { ClaimKind, Recommendation, Risk } from "./intelligence";
import type { Evidence } from "./evidence";

/** One agent's contribution to a merged result, with the weight it earned. */
export interface AgentContribution {
  agentId: string;
  agentName: string;
  outputId: string;
  /** Normalized weight in [0,1]; contributions sum to 1. */
  weight: number;
  /** Share of merged claims this agent supported, in [0,1]. */
  agreement: number;
  /** Per-factor breakdown so a weight is always explainable. */
  breakdown: Record<string, number>;
}

/** A claim after merging equivalent statements across agents. */
export interface ConsensusClaim {
  statement: string;
  kind: ClaimKind;
  /** Weighted confidence across supporting agents, in [0,1]. */
  confidence: number;
  /** Weighted share of participating agents that asserted this claim. */
  support: number;
  /** Agents that asserted it. */
  supportedBy: string[];
  /** Agents that asserted a directly contradicting claim. */
  contradictedBy: string[];
  supportingEvidence: Evidence[];
  contradictingEvidence: Evidence[];
}

/** A claim the cohort materially split on — surfaced rather than averaged. */
export interface Disagreement {
  statement: string;
  supportWeight: number;
  opposeWeight: number;
  positions: Array<{ agentId: string; statement: string; confidence: number }>;
}

export interface ConsensusOutcome {
  strategy: string;
  strategyConfig: Record<string, unknown>;
  summary: string;
  confidence: number;
  /**
   * Inter-agent agreement in [0,1]. Low score = weak consensus, not low
   * confidence. Scaled by how much independent corroboration actually exists,
   * so a cohort that collapsed to one agent cannot report full consensus.
   */
  consensusScore: number;
  /** How much independent corroboration backed the result, 0..1. */
  corroboration: CorroborationBreadth;
  claims: ConsensusClaim[];
  metrics: Record<string, number | string>;
  recommendation: Recommendation | null;
  risks: Risk[];
  disagreements: Disagreement[];
  contributions: AgentContribution[];
}

/**
 * How broadly the result was corroborated.
 *
 * Reported alongside consensus because "every agent agreed" means something
 * very different at one agent than at five, and a single number cannot carry
 * both facts honestly.
 */
export interface CorroborationBreadth {
  /** Agents that actually submitted usable output. */
  cohortSize: number;
  /** Agents the job asked for. */
  expected: number;
  /** Multiplier applied to the raw agreement score, 0..1. */
  factor: number;
  /** True when fewer agents finished than the job requested. */
  short: boolean;
}

/** Input row for the consensus engine — one agent's submitted output. */
export interface ConsensusInput {
  outputId: string;
  agentId: string;
  agentName: string;
  summary: string;
  confidence: number;
  claims: Array<{
    statement: string;
    kind: ClaimKind;
    confidence: number;
    fingerprint: string;
    evidence: Evidence[];
  }>;
  metrics: Record<string, number | string>;
  recommendation: Recommendation | null;
  risks: Risk[];
  /** Signals the weighting strategy may use. */
  signals: {
    reputation: number;
    domainReputation: number;
    accuracy: number;
    calibration: number;
    evidenceQuality: number;
    /** Evaluation score from the evaluation engine, if it has run. */
    evaluation: number | null;
  };
}
