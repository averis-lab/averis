import { contentSet, polarity, similarity } from "@averis/consensus";
import type { ConsensusInput } from "@averis/types";

export interface EvaluationScores {
  outputId: string;
  agentId: string;
  /** Mean reliability of cited evidence, scaled by how much is cited at all. */
  evidenceQuality: number;
  /** Absence of self-contradiction inside a single output. */
  internalConsistency: number;
  /** Concreteness: figures and named subjects rather than hedged prose. */
  specificity: number;
  /** Agreement with the rest of the cohort on the topics it addressed. */
  corroboration: number;
  /**
   * Overlap between the output's vocabulary and the terms the datanet's own
   * rubric emphasises. Term coverage, not comprehension. Neutral at 0.5 when
   * the datanet publishes no rubric, so an undocumented datanet is never
   * penalised for it.
   */
  rubricAlignment: number;
  overall: number;
  notes: Record<string, unknown>;
}

export interface EvaluationConfig {
  weights?: {
    evidenceQuality?: number;
    internalConsistency?: number;
    specificity?: number;
    corroboration?: number;
    rubricAlignment?: number;
  };
  /** Token-overlap above which two claims are treated as the same topic. */
  similarityThreshold?: number;
}

/**
 * Scores each agent's output before consensus runs.
 *
 * Deliberately deterministic — no model is asked to grade another model here.
 * An LLM judge would introduce exactly the correlated error that multi-agent
 * analysis exists to avoid, and it could not be replayed or audited. Every
 * dimension below is computed from the output's own structure and its
 * relationship to the cohort.
 *
 * `EvaluationEngine` is an interface boundary, so an agent-based evaluator can
 * be added later as an additional evaluator rather than a replacement.
 */
export class EvaluationEngine {
  readonly name = "deterministic-v1";
  private readonly weights: Required<NonNullable<EvaluationConfig["weights"]>>;
  private readonly similarityThreshold: number;

  constructor(config: EvaluationConfig = {}) {
    this.weights = {
      evidenceQuality: config.weights?.evidenceQuality ?? 0.4,
      internalConsistency: config.weights?.internalConsistency ?? 0.2,
      specificity: config.weights?.specificity ?? 0.15,
      corroboration: config.weights?.corroboration ?? 0.22,
      // Deliberately the smallest weight of the five. It is keyword overlap
      // against prose, which is a weak proxy for actually working to a
      // standard; letting it carry more would reward vocabulary mimicry.
      rubricAlignment: config.weights?.rubricAlignment ?? 0.08,
    };
    this.similarityThreshold = config.similarityThreshold ?? 0.4;
  }

  /**
   * @param rubricTerms Salient terms from the datanets in scope. Omit when the
   *   job's datanets publish no standard; alignment then stays neutral.
   */
  evaluate(inputs: ConsensusInput[], rubricTerms: Set<string> = new Set()): EvaluationScores[] {
    return inputs.map((input) => {
      const evidenceQuality = this.scoreEvidence(input);
      const internalConsistency = this.scoreConsistency(input);
      const specificity = this.scoreSpecificity(input);
      const corroboration = this.scoreCorroboration(input, inputs);
      const rubricAlignment = this.scoreRubricAlignment(input, rubricTerms);

      const overall = clamp01(
        evidenceQuality * this.weights.evidenceQuality +
          internalConsistency * this.weights.internalConsistency +
          specificity * this.weights.specificity +
          corroboration * this.weights.corroboration +
          rubricAlignment * this.weights.rubricAlignment,
      );

      return {
        outputId: input.outputId,
        agentId: input.agentId,
        evidenceQuality,
        internalConsistency,
        specificity,
        corroboration,
        rubricAlignment,
        overall,
        notes: {
          claimCount: input.claims.length,
          unsupportedClaims: input.claims.filter((c) => c.evidence.length === 0).length,
          weights: this.weights,
          rubricTermCount: rubricTerms.size,
          evaluator: this.name,
        },
      };
    });
  }

  /**
   * Two things matter: how well-curated the cited sources are, and what share
   * of claims cite anything at all. An output with one immaculate citation and
   * nine bare assertions is not a well-evidenced output.
   */
  private scoreEvidence(input: ConsensusInput): number {
    if (input.claims.length === 0) return 0;

    const supported = input.claims.filter((c) => c.evidence.length > 0);
    const coverage = supported.length / input.claims.length;
    if (supported.length === 0) return 0;

    const meanReliability =
      supported.reduce((acc, claim) => {
        const mean =
          claim.evidence.reduce((sum, e) => sum + e.reliability, 0) / claim.evidence.length;
        return acc + mean;
      }, 0) / supported.length;

    // Citing several independent sources for one claim is worth more than one.
    const distinctSources = new Set(
      input.claims.flatMap((c) => c.evidence.map((e) => e.source)),
    ).size;
    const breadth = Math.min(1, distinctSources / Math.max(3, input.claims.length));

    return clamp01(meanReliability * 0.55 + coverage * 0.3 + breadth * 0.15);
  }

  /**
   * Penalizes an output that asserts and denies the same topic. Self-
   * contradiction is a strong signal the agent is pattern-matching rather than
   * reasoning, and it is invisible to any single-claim check.
   */
  private scoreConsistency(input: ConsensusInput): number {
    const claims = input.claims.map((claim) => ({
      tokens: contentSet(claim.statement),
      stance: polarity(claim.statement),
      confidence: claim.confidence,
    }));

    if (claims.length < 2) return 1;

    let conflicts = 0;
    let comparisons = 0;

    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i]!;
        const b = claims[j]!;
        if (similarity(a.tokens, b.tokens) < this.similarityThreshold) continue;
        comparisons++;
        if (a.stance !== 0 && b.stance !== 0 && a.stance !== b.stance) conflicts++;
      }
    }

    if (comparisons === 0) return 1;
    return clamp01(1 - conflicts / comparisons);
  }

  /**
   * Concrete claims carry figures, units and named subjects. Hedging language
   * is penalized because a hedged claim is unfalsifiable, and an unfalsifiable
   * claim can never move the agent's accuracy in either direction.
   */
  private scoreSpecificity(input: ConsensusInput): number {
    if (input.claims.length === 0) return 0;

    const HEDGES = /\b(may|might|could|possibly|perhaps|appears?|seems?|suggests?|somewhat|generally|typically)\b/gi;

    const scores = input.claims.map((claim) => {
      const text = claim.statement;
      const hasNumber = /\d/.test(text) ? 1 : 0;
      const hasUnit = /(%|percent|usd|\$|epoch|volume|bps|x\b)/i.test(text) ? 1 : 0;
      const hasQuoted = /["“'‘]/.test(text) ? 1 : 0;
      const hedges = (text.match(HEDGES) ?? []).length;
      const lengthOk = text.length >= 40 && text.length <= 320 ? 1 : 0.5;

      const positive = (hasNumber * 0.4 + hasUnit * 0.25 + hasQuoted * 0.1 + lengthOk * 0.25);
      return clamp01(positive - hedges * 0.15);
    });

    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * How much of the rest of the cohort landed on the same side of the topics
   * this agent addressed.
   *
   * A lone dissenter scores low here, which is intended — but corroboration is
   * only one of four dimensions and carries 0.25 weight, so a well-evidenced,
   * specific, internally consistent dissent still scores respectably. That is
   * the point: the protocol must not price correct minority positions out of
   * existence.
   */
  /**
   * Share of the datanet's own vocabulary the output actually engages with.
   *
   * A robotics datanet asking about "occlusion" and "timestamps" and a trading
   * datanet asking about "regime" and "tx hashes" want different work; an
   * output that never touches its datanet's vocabulary is probably answering a
   * generic question. Weak evidence, which is why it carries 0.08.
   */
  private scoreRubricAlignment(input: ConsensusInput, rubricTerms: Set<string>): number {
    if (rubricTerms.size === 0) return 0.5;
    if (input.claims.length === 0) return 0;

    const used = contentSet(
      [input.summary, ...input.claims.map((c) => c.statement)].join(" "),
    );

    let hits = 0;
    for (const term of rubricTerms) if (used.has(term)) hits++;

    // Saturating rather than linear: touching a quarter of a long rubric's
    // vocabulary already shows the agent worked to that standard, and full
    // coverage of a 200-term rubric is neither achievable nor desirable.
    return clamp01(Math.min(1, hits / Math.max(4, rubricTerms.size * 0.25)));
  }

  private scoreCorroboration(input: ConsensusInput, cohort: ConsensusInput[]): number {
    const others = cohort.filter((c) => c.outputId !== input.outputId);
    if (others.length === 0) return 0.5;
    if (input.claims.length === 0) return 0;

    const otherClaims = others.flatMap((o) =>
      o.claims.map((c) => ({ tokens: contentSet(c.statement), stance: polarity(c.statement) })),
    );

    const perClaim = input.claims.map((claim) => {
      const tokens = contentSet(claim.statement);
      const stance = polarity(claim.statement);

      const related = otherClaims.filter(
        (other) => similarity(tokens, other.tokens) >= this.similarityThreshold,
      );
      // A claim nobody else addressed is neither corroborated nor refuted.
      if (related.length === 0) return 0.5;

      const agreeing = related.filter(
        (other) => other.stance === stance || other.stance === 0 || stance === 0,
      ).length;
      return agreeing / related.length;
    });

    return perClaim.reduce((a, b) => a + b, 0) / perClaim.length;
  }
}

/**
 * Extracts the terms a datanet's rubric leans on.
 *
 * Stopwords and the rubric's own boilerplate ("score", "vote", "submit") are
 * dropped, because every rubric contains those and matching them would measure
 * nothing. What remains is domain vocabulary: "regime", "latency", "tx hash",
 * "timestamps".
 */
export function extractRubricTerms(rubrics: Array<{ publisherSpec: string; voterRubric: string }>): Set<string> {
  const BOILERPLATE = new Set([
    "score", "scores", "scoring", "vote", "votes", "voting", "voter", "voters",
    "submit", "submission", "submissions", "publish", "publisher", "publishers",
    "datanet", "pod", "pods", "content", "data", "quality", "good", "high", "low",
    "reppo", "stake", "reward", "rewards", "contributor", "contributors",
  ]);

  const terms = new Set<string>();
  for (const rubric of rubrics) {
    for (const token of contentSet(`${rubric.publisherSpec} ${rubric.voterRubric}`)) {
      if (token.length < 4 || BOILERPLATE.has(token)) continue;
      terms.add(token);
    }
  }
  return terms;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
