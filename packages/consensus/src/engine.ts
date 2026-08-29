import type {
  AgentContribution,
  CohortIndependence,
  ConsensusClaim,
  CorroborationBreadth,
  ConsensusInput,
  ConsensusOutcome,
  Disagreement,
  Evidence,
  Recommendation,
  Risk,
} from "@averis/types";
import { LexicalClusterer, toClaimRefs, type ClaimCluster, type ClaimClusterer, type ClaimRef } from "./cluster";
import { describeIndependence, measureIndependence, modelOrigin } from "./independence";
import { MultiFactorWeighting, type AgentWeight, type WeightingStrategy } from "./weighting";

export interface ConsensusConfig {
  strategy?: WeightingStrategy;
  clusterer?: ClaimClusterer;
  /**
   * Weighted support below which a claim is dropped from the final result.
   * A claim asserted by one low-weight agent alone is not intelligence.
   */
  minSupport?: number;
  /**
   * Opposing weight above which a topic is reported as a disagreement instead
   * of being flattened into a single averaged claim.
   */
  disagreementThreshold?: number;
}

export interface RunOptions {
  /**
   * Agents the job asked for. Used to scale the consensus score by how much
   * independent corroboration actually materialised.
   */
  expectedCohortSize?: number;
}

/**
 * How much a cohort of `n` corroborates, relative to a cohort of `expected`.
 *
 * One agent agreeing with itself is not corroboration, so the factor is 0 at
 * n = 1 no matter what was expected. Above that it rises on 1 - 1/n, which is
 * steep between one and three agents and flattens after, matching how quickly
 * the value of an extra independent opinion falls off. It is normalised so a
 * cohort that met its target scores a full 1.
 */
export function corroborationFactor(cohortSize: number, expected: number): number {
  if (cohortSize <= 1) return 0;

  const target = Math.max(2, expected);
  const reached = 1 - 1 / cohortSize;
  const full = 1 - 1 / target;

  return Math.min(1, reached / full);
}

/**
 * Merges independent agent outputs into a single verifiable result.
 *
 * The engine never averages a contested topic into a middle position. Where
 * agents genuinely conflict, the conflict is reported — an averaged claim that
 * no agent actually made is worse than an honest split, because it destroys the
 * evidence trail on both sides.
 */
export class ConsensusEngine {
  private readonly strategy: WeightingStrategy;
  private readonly clusterer: ClaimClusterer;
  private readonly minSupport: number;
  private readonly disagreementThreshold: number;

  constructor(config: ConsensusConfig = {}) {
    this.strategy = config.strategy ?? new MultiFactorWeighting();
    this.clusterer = config.clusterer ?? new LexicalClusterer();
    this.minSupport = config.minSupport ?? 0.15;
    this.disagreementThreshold = config.disagreementThreshold ?? 0.2;
  }

  run(inputs: ConsensusInput[], options: RunOptions = {}): ConsensusOutcome {
    if (inputs.length === 0) {
      throw new Error("Consensus requires at least one agent output");
    }

    const expected = Math.max(1, options.expectedCohortSize ?? inputs.length);
    const corroboration: CorroborationBreadth = {
      cohortSize: inputs.length,
      expected,
      factor: corroborationFactor(inputs.length, expected),
      short: inputs.length < expected,
    };

    const weights = this.strategy.weigh(inputs);
    const weightByOutput = new Map(weights.map((w) => [w.outputId, w]));
    const clusters = this.clusterer.cluster(toClaimRefs(inputs));

    const claims: ConsensusClaim[] = [];
    const disagreements: Disagreement[] = [];
    // Tracks, per agent, how much merged weight they ended up aligned with.
    const alignment = new Map<string, { agreed: number; total: number }>();
    for (const w of weights) alignment.set(w.outputId, { agreed: 0, total: 0 });

    for (const cluster of clusters) {
      const merged = this.mergeCluster(cluster, weightByOutput, alignment);
      if (merged.disagreement) disagreements.push(merged.disagreement);
      if (merged.claim) claims.push(merged.claim);
    }

    // Rank by conviction: how much of the cohort backed it, then how sure.
    claims.sort((a, b) => b.support * b.confidence - a.support * a.confidence);

    const contributions: AgentContribution[] = inputs.map((input) => {
      const weight = weightByOutput.get(input.outputId);
      const align = alignment.get(input.outputId) ?? { agreed: 0, total: 0 };
      return {
        agentId: input.agentId,
        agentName: input.agentName,
        outputId: input.outputId,
        weight: weight?.weight ?? 0,
        agreement: align.total > 0 ? align.agreed / align.total : 0,
        breakdown: weight?.breakdown ?? {},
        modelProvider: input.modelProvider,
        modelName: input.modelName,
        modelOrigin: modelOrigin(input.modelProvider, input.modelName),
      };
    });

    // Measured from the contributions rather than the raw inputs, so an origin
    // that carried almost none of the weight is not counted as a full voice.
    const independence = measureIndependence(
      contributions.map((row) => ({
        modelProvider: row.modelProvider,
        modelName: row.modelName,
        weight: row.weight,
      })),
    );

    // Agreement is scaled by corroboration breadth. Without this a lone
    // survivor reports the same 100% consensus as a cohort of three that
    // genuinely converged, which overstates the result to the reader.
    const agreement = this.scoreConsensus(claims, disagreements, contributions);
    const consensusScore = agreement * corroboration.factor;
    const confidence = this.scoreConfidence(claims, consensusScore);

    return {
      strategy: this.strategy.name,
      strategyConfig: {
        ...this.strategy.config,
        clusterer: this.clusterer.name,
        minSupport: this.minSupport,
        disagreementThreshold: this.disagreementThreshold,
        rawAgreement: round(agreement),
        corroborationFactor: round(corroboration.factor),
      },
      summary: this.buildSummary(
        inputs,
        claims,
        disagreements,
        consensusScore,
        confidence,
        corroboration,
        independence,
      ),
      confidence,
      consensusScore,
      corroboration,
      independence,
      claims,
      metrics: this.mergeMetrics(inputs, weightByOutput),
      recommendation: this.mergeRecommendation(inputs, weightByOutput, corroboration),
      risks: this.mergeRisks(inputs),
      disagreements,
      contributions,
    };
  }

  private mergeCluster(
    cluster: ClaimCluster,
    weights: Map<string, AgentWeight>,
    alignment: Map<string, { agreed: number; total: number }>,
  ): { claim: ConsensusClaim | null; disagreement: Disagreement | null } {
    const weightOf = (ref: ClaimRef): number => weights.get(ref.outputId)?.weight ?? 0;

    // A neutral-stance claim sides with whichever camp is larger, so a purely
    // factual restatement is not counted as its own third position.
    const asserting = cluster.members.filter((m) => m.stance >= 0);
    const denying = cluster.members.filter((m) => m.stance < 0);

    // Weight is per *agent*, not per claim. An agent that phrases the same
    // position twice must not have its voice counted twice — that is how a
    // cluster ends up reporting 200% support.
    const assertWeight = distinctWeight(asserting, weightOf);
    const denyWeight = distinctWeight(denying, weightOf);

    const majority = assertWeight >= denyWeight ? asserting : denying;
    const minority = assertWeight >= denyWeight ? denying : asserting;
    const majorityWeight = Math.max(assertWeight, denyWeight);
    const minorityWeight = Math.min(assertWeight, denyWeight);

    for (const member of cluster.members) {
      const row = alignment.get(member.outputId);
      if (!row) continue;
      row.total += 1;
      if (majority.includes(member)) row.agreed += 1;
    }

    let disagreement: Disagreement | null = null;
    if (minorityWeight >= this.disagreementThreshold && minority.length > 0) {
      disagreement = {
        statement: representativeOf(majority).statement,
        supportWeight: round(majorityWeight),
        opposeWeight: round(minorityWeight),
        positions: cluster.members.map((m) => ({
          agentId: m.agentId,
          statement: m.statement,
          confidence: m.confidence,
        })),
      };
    }

    if (majorityWeight < this.minSupport) return { claim: null, disagreement };

    const representative = representativeOf(majority);
    // Confidence is weighted by how much cohort weight stands behind each
    // agent's stated confidence — not a flat mean across agents. An agent
    // contributing several claims to the cluster is represented once, by its
    // most confident phrasing.
    const bestPerAgent = new Map<string, ClaimRef>();
    for (const member of majority) {
      const existing = bestPerAgent.get(member.outputId);
      if (!existing || member.confidence > existing.confidence) {
        bestPerAgent.set(member.outputId, member);
      }
    }
    const confidence =
      majorityWeight > 0
        ? sumBy([...bestPerAgent.values()], (m) => weightOf(m) * m.confidence) / majorityWeight
        : representative.confidence;

    return {
      claim: {
        statement: representative.statement,
        kind: representative.kind,
        confidence: clamp01(confidence),
        support: round(majorityWeight),
        supportedBy: unique(majority.map((m) => m.agentId)),
        contradictedBy: unique(minority.map((m) => m.agentId)),
        supportingEvidence: dedupeEvidence(majority.flatMap((m) => m.evidence)),
        contradictingEvidence: dedupeEvidence(minority.flatMap((m) => m.evidence)),
      },
      disagreement,
    };
  }

  /**
   * How much the cohort actually agreed, blending per-claim support with the
   * share of topics that split. Reported separately from confidence: a cohort
   * can be confidently split, and collapsing the two would hide that.
   */
  private scoreConsensus(
    claims: ConsensusClaim[],
    disagreements: Disagreement[],
    contributions: AgentContribution[],
  ): number {
    if (claims.length === 0) return 0;

    const meanSupport = claims.reduce((acc, c) => acc + c.support, 0) / claims.length;
    const topics = claims.length + disagreements.length;
    const contested = topics === 0 ? 0 : disagreements.length / topics;
    const meanAlignment =
      contributions.length === 0
        ? 0
        : contributions.reduce((acc, c) => acc + c.agreement, 0) / contributions.length;

    return clamp01(meanSupport * 0.5 + meanAlignment * 0.3 + (1 - contested) * 0.2);
  }

  /** Support-weighted confidence, discounted when the cohort is split. */
  private scoreConfidence(claims: ConsensusClaim[], consensusScore: number): number {
    if (claims.length === 0) return 0;
    const totalSupport = claims.reduce((acc, c) => acc + c.support, 0);
    const weighted =
      totalSupport > 0
        ? claims.reduce((acc, c) => acc + c.confidence * c.support, 0) / totalSupport
        : 0;
    // A confident-but-split cohort must not present as a confident result.
    return clamp01(weighted * (0.6 + 0.4 * consensusScore));
  }

  private buildSummary(
    inputs: ConsensusInput[],
    claims: ConsensusClaim[],
    disagreements: Disagreement[],
    consensusScore: number,
    confidence: number,
    corroboration: CorroborationBreadth,
    independence: CohortIndependence,
  ): string {
    if (claims.length === 0) {
      return `${inputs.length} agents produced no claim meeting the ${this.minSupport} support threshold. No intelligence could be established.`;
    }

    const lead = claims[0]!;

    // A single agent cannot corroborate itself, and saying so plainly matters
    // more than a tidy sentence: the reader would otherwise take the headline
    // numbers as agreement between independent analysts.
    if (corroboration.cohortSize === 1) {
      return `Only 1 of ${corroboration.expected} agents produced usable output, so nothing here is corroborated by a second analyst. Reported at ${(confidence * 100).toFixed(0)}% confidence with no consensus. Sole finding: ${lead.statement}`;
    }

    const shortfall = corroboration.short
      ? ` Only ${corroboration.cohortSize} of ${corroboration.expected} agents finished, so consensus is discounted accordingly.`
      : "";

    const contested =
      disagreements.length > 0
        ? ` ${disagreements.length} topic(s) remain contested and are reported separately rather than averaged.`
        : " The cohort did not materially disagree on any topic.";

    // Said in the summary and not only in a field: the number a reader carries
    // away is "they agreed", and how much that is worth belongs in the same
    // breath as the claim, not one level down in a structure nobody opens.
    const cohort = describeIndependence(independence, corroboration.cohortSize);

    return `${inputs.length} independent agents produced ${claims.length} corroborated claim(s) at ${(confidence * 100).toFixed(0)}% confidence and ${(consensusScore * 100).toFixed(0)}% consensus.${shortfall} Lead finding: ${lead.statement}${contested}${cohort === null ? "" : ` ${cohort}`}`;
  }

  private mergeMetrics(
    inputs: ConsensusInput[],
    weights: Map<string, AgentWeight>,
  ): Record<string, number | string> {
    const numeric = new Map<string, { value: number; weight: number }>();
    const textual = new Map<string, string>();

    for (const input of inputs) {
      const weight = weights.get(input.outputId)?.weight ?? 0;
      for (const [key, value] of Object.entries(input.metrics)) {
        if (typeof value === "number") {
          const row = numeric.get(key) ?? { value: 0, weight: 0 };
          row.value += value * weight;
          row.weight += weight;
          numeric.set(key, row);
        } else if (!textual.has(key)) {
          textual.set(key, value);
        }
      }
    }

    const merged: Record<string, number | string> = {};
    for (const [key, row] of numeric) {
      merged[key] = row.weight > 0 ? round(row.value / row.weight, 6) : 0;
    }
    for (const [key, value] of textual) if (!(key in merged)) merged[key] = value;
    return merged;
  }

  /** The recommendation of the agent carrying the most weight — not a blend. */
  private mergeRecommendation(
    inputs: ConsensusInput[],
    weights: Map<string, AgentWeight>,
    corroboration: CorroborationBreadth,
  ): Recommendation | null {
    const candidates = inputs
      .filter((i) => i.recommendation !== null)
      .map((i) => ({ input: i, weight: weights.get(i.outputId)?.weight ?? 0 }))
      .sort((a, b) => b.weight - a.weight);

    const top = candidates[0];
    if (!top?.input.recommendation) return null;

    // Agreement among recommendations scales the confidence we report.
    const agreeing = candidates.filter(
      (c) => c.input.recommendation?.action === top.input.recommendation?.action,
    );
    const agreementWeight = agreeing.reduce((acc, c) => acc + c.weight, 0);

    // Corroboration gates the recommendation too. A lone agent calling a
    // corpus decision-grade must not read as a confident recommendation while
    // the rest of the page says nothing was corroborated.
    const breadth = 0.4 + 0.6 * corroboration.factor;

    return {
      action: top.input.recommendation.action,
      rationale: top.input.recommendation.rationale,
      confidence: clamp01(
        top.input.recommendation.confidence * (0.5 + 0.5 * agreementWeight) * breadth,
      ),
    };
  }

  /** Risks are unioned, never averaged — the worst case is what matters. */
  private mergeRisks(inputs: ConsensusInput[]): Risk[] {
    const bySeverity = new Map<string, Risk>();
    const rank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;

    for (const input of inputs) {
      for (const risk of input.risks) {
        const key = risk.description.toLowerCase().slice(0, 120);
        const existing = bySeverity.get(key);
        if (!existing || rank[risk.severity] > rank[existing.severity]) {
          bySeverity.set(key, risk);
        }
      }
    }

    return [...bySeverity.values()].sort((a, b) => rank[b.severity] - rank[a.severity]);
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sumBy<T>(rows: T[], fn: (row: T) => number): number {
  return rows.reduce((acc, row) => acc + fn(row), 0);
}

/** Sums each agent's weight once, however many claims it put in the cluster. */
function distinctWeight(members: ClaimRef[], weightOf: (ref: ClaimRef) => number): number {
  const seen = new Map<string, number>();
  for (const member of members) {
    if (!seen.has(member.outputId)) seen.set(member.outputId, weightOf(member));
  }
  return [...seen.values()].reduce((a, b) => a + b, 0);
}

/** The clearest wording of a position: highest confidence, ties broken stably. */
function representativeOf(members: ClaimRef[]): ClaimRef {
  return [...members].sort(
    (a, b) => b.confidence - a.confidence || a.statement.localeCompare(b.statement),
  )[0]!;
}

function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of evidence) {
    if (seen.has(item.source)) continue;
    seen.add(item.source);
    out.push(item);
  }
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function round(n: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}
