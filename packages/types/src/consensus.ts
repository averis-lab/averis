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
  /** Provider this output actually ran on, as recorded when it was produced. */
  modelProvider: string;
  modelName: string;
  /** The vendor behind that model — resolved through gateways. See modelOrigin. */
  modelOrigin: string;
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
  /** How independent the agreeing voices were, in model terms. */
  independence: CohortIndependence;
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

/** One vendor's footprint in a cohort. */
export interface OriginShare {
  /** The vendor whose model answered — never the gateway it was routed through. */
  origin: string;
  /** Contributing agents running on it. */
  agents: number;
  /** Their combined normalized weight, 0..1. */
  weight: number;
}

/**
 * How independent the cohort's voices actually were.
 *
 * Reported for the same reason as {@link CorroborationBreadth}, one level
 * down. That answers how many analysts agreed; this answers how many
 * different things were doing the analysing. Five agents are five opinions
 * only if they can be wrong in different ways — a cohort sharing one model
 * shares its blind spots, so its unanimity is partly an artifact of that
 * model rather than a finding about the world.
 *
 * **Deliberately no multiplier.** `CorroborationBreadth` carries a `factor`
 * that discounts the score, because at one agent there is arithmetically no
 * inter-agent agreement to measure. Monoculture has no such clean zero: agents
 * on one model given different roles and evidence do genuinely differ, just
 * less. Folding a made-up coefficient into `consensusScore` would leave that
 * number answering two questions at once — how much they agreed, and how much
 * that agreement is worth — and it is the second one a reader must be free to
 * judge. So this is measured, reported and stated in the summary, and the
 * score stays a measurement of agreement.
 */
export interface CohortIndependence {
  /** Distinct origins, heaviest first. */
  origins: OriginShare[];
  /**
   * Weight-aware origin count, between 1 and `origins.length`.
   *
   * Three vendors where one carries 90% of the weight is not three
   * independent voices, and a plain count would say it was.
   */
  effectiveOrigins: number;
  /** Weighted share held by the single largest origin, 0..1. */
  largestOriginShare: number;
  /** Distinct provider/model pairs across the cohort. */
  distinctModels: number;
  /** Every contributing agent ran the same model. */
  monoculture: boolean;
  /**
   * At least one output has no recorded binding, so nothing above can be
   * trusted as complete. True for jobs that ran before the binding was
   * recorded; reported rather than guessed at.
   */
  unknown: boolean;
}

/** Input row for the consensus engine — one agent's submitted output. */
export interface ConsensusInput {
  outputId: string;
  agentId: string;
  agentName: string;
  summary: string;
  confidence: number;
  /**
   * The model that produced this output, as recorded at the time it ran.
   *
   * Not read by the merge itself — nothing here changes which claims survive.
   * It is carried so the result can say how independent the cohort's voices
   * actually were, which is a fact about the cohort and not about the claims.
   * An empty string means the run predates the recording of it; see
   * {@link CohortIndependence.unknown}.
   */
  modelProvider: string;
  modelName: string;
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
