import type { ClaimKind } from "@averis/types";

/**
 * Why a conclusion says what it says.
 *
 * Every number here already exists somewhere in a finished job — the merge
 * computed support and contradiction, the evaluator scored each output, and
 * the tool runtime recorded the upstream curation behind every piece of
 * evidence. What was missing was the assembly: a reader could see that
 * confidence was 0.78 and had no way to ask *how*.
 *
 * This module is pure. It takes a finished job's parts and returns the causal
 * chain — verdict, then the claims under it, then the evidence under those,
 * with the upstream vote volumes that gave each source its weight. No database
 * and no recomputation of the analysis itself: an explanation that re-derived
 * the result could disagree with the result, which would make it worse than
 * useless.
 */

/**
 * What the protocol is willing to say about one claim.
 *
 * Deliberately four values rather than a score. A verdict is a decision about
 * whether a statement may be relied on, and collapsing "nobody contradicted it
 * but only one agent said it" into a number is exactly the flattening this
 * project exists to avoid.
 */
export type ClaimVerdict = "SUPPORTED" | "DISPUTED" | "THIN" | "UNSUPPORTED";

/** Upstream curation as recorded when the evidence was retrieved. */
export interface EvidenceCuration {
  upVotes: number;
  downVotes: number;
  approvalRate: number;
  epoch: number | null;
}

export interface ExplainedEvidence {
  source: string;
  title: string | null;
  /** Upstream curation-derived reliability, 0..1. Not the agent's opinion. */
  reliability: number;
  stance: "supports" | "contradicts";
  curation: EvidenceCuration | null;
}

export interface ExplainableClaim {
  statement: string;
  kind: ClaimKind | string;
  confidence: number;
  /** Weighted share of participating agents that asserted it, 0..1. */
  support: number;
  supportedBy: string[];
  contradictedBy: string[];
  evidence: ExplainedEvidence[];
}

export interface ExplainedClaim extends ExplainableClaim {
  verdict: ClaimVerdict;
  /** Weight-free mean reliability of the evidence actually cited in support. */
  evidenceQuality: number;
  /** The chain, in the order a reader would ask for it. */
  reasons: string[];
}

/**
 * Thresholds, named so they can be argued with.
 *
 * `THIN_EVIDENCE` sits at the reliability the runtime assigns unvetted web
 * content: a claim resting on sources no better than an unchecked page is not
 * unsupported, but it is not something to act on either.
 */
export const EXPLAIN_THRESHOLDS = {
  THIN_EVIDENCE: 0.35,
  LONE_AGENT: 1,
} as const;

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** Mean reliability of the supporting evidence; 0 when nothing supports it. */
function evidenceQualityOf(evidence: ExplainedEvidence[]): number {
  const supporting = evidence.filter((item) => item.stance === "supports");
  if (supporting.length === 0) return 0;
  return supporting.reduce((sum, item) => sum + item.reliability, 0) / supporting.length;
}

/**
 * The verdict rules, in order of severity.
 *
 * Order matters: a contradicted claim is disputed even when it is thin, and an
 * unsupported one is unsupported however many agents asserted it — a claim
 * nobody could evidence does not become true by being popular.
 */
export function verdictFor(claim: ExplainableClaim, evidenceQuality: number): ClaimVerdict {
  const supporting = claim.evidence.filter((item) => item.stance === "supports");

  if (supporting.length === 0) return "UNSUPPORTED";
  if (claim.contradictedBy.length > 0) return "DISPUTED";
  if (claim.evidence.some((item) => item.stance === "contradicts")) return "DISPUTED";
  if (claim.supportedBy.length <= EXPLAIN_THRESHOLDS.LONE_AGENT) return "THIN";
  if (evidenceQuality < EXPLAIN_THRESHOLDS.THIN_EVIDENCE) return "THIN";

  return "SUPPORTED";
}

/**
 * The numbered chain behind one claim.
 *
 * Written as sentences a person can check rather than a blob of fields,
 * because the point of this feature is that a reader can follow the reasoning
 * back to something outside the model.
 */
export function reasonsFor(
  claim: ExplainableClaim,
  evidenceQuality: number,
  cohortSize: number,
): string[] {
  const reasons: string[] = [];
  const supporting = claim.evidence.filter((item) => item.stance === "supports");

  if (claim.supportedBy.length > 0) {
    reasons.push(
      cohortSize > 0
        ? `${claim.supportedBy.length} of ${cohortSize} agents asserted this independently.`
        : `${claim.supportedBy.length} agent(s) asserted this.`,
    );
  }

  if (supporting.length > 0) {
    reasons.push(
      `It cites ${supporting.length} piece(s) of retrieved evidence, ` +
        `mean upstream reliability ${evidenceQuality.toFixed(2)}.`,
    );

    // The strongest source is quoted with the upstream numbers that earned it
    // its weight — this is the point where the trail leaves the model entirely
    // and lands on a curation market someone staked on.
    const strongest = [...supporting].sort((a, b) => b.reliability - a.reliability)[0]!;
    if (strongest.curation) {
      const { upVotes, downVotes, approvalRate, epoch } = strongest.curation;
      reasons.push(
        `Its strongest source (${strongest.source}) carried ${upVotes} up-vote volume ` +
          `against ${downVotes} down (${pct(approvalRate)} approval)` +
          `${epoch === null ? "" : ` in epoch ${epoch}`}.`,
      );
    } else {
      reasons.push(
        `Its strongest source (${strongest.source}) was recorded at reliability ` +
          `${strongest.reliability.toFixed(2)}.`,
      );
    }
  } else {
    reasons.push("No retrieved evidence supports it, so it was not relied on.");
  }

  if (claim.contradictedBy.length > 0) {
    reasons.push(
      `${claim.contradictedBy.length} agent(s) asserted the opposite; both positions are kept.`,
    );
  } else if (claim.supportedBy.length > 0) {
    reasons.push("No agent contradicted it.");
  }

  return reasons;
}

export function explainClaim(claim: ExplainableClaim, cohortSize: number): ExplainedClaim {
  const evidenceQuality = evidenceQualityOf(claim.evidence);

  return {
    ...claim,
    evidenceQuality,
    verdict: verdictFor(claim, evidenceQuality),
    reasons: reasonsFor(claim, evidenceQuality, cohortSize),
  };
}

export interface ExplainableJob {
  confidence: number;
  consensusScore: number;
  minimumConfidence: number | null;
  corroboration: { cohortSize: number; expected: number; factor: number; short: boolean } | null;
  /**
   * What the cohort was made of, as measured when the merge ran.
   *
   * Null for a job finished before this was recorded, which is not the same
   * as a cohort that turned out to be uniform — an explanation that could not
   * tell those apart would be asserting something it does not know.
   */
  independence: {
    origins: Array<{ origin: string; agents: number; weight: number }>;
    effectiveOrigins: number;
    distinctModels: number;
    monoculture: boolean;
    unknown: boolean;
  } | null;
  claims: ExplainableClaim[];
  disagreements: Array<{ statement: string }>;
  /** Deterministic evaluation scores, one per agent output. */
  evaluations: Array<{ agentName: string; overall: number }>;
}

/**
 * The three reliabilities, kept apart on purpose.
 *
 * One "confidence" number would have to answer three different questions at
 * once: was the input trustworthy, was the reasoning sound, and has this
 * cohort been right before. They fail independently, so they are reported
 * independently. `outcome` is null until predictions have actually resolved —
 * reporting a placeholder there would be the one lie this whole design exists
 * to prevent.
 */
export interface ReliabilityBreakdown {
  evidence: number;
  reasoning: number;
  outcome: number | null;
}

export interface Explanation {
  verdict: ClaimVerdict;
  confidence: number;
  consensusScore: number;
  reliability: ReliabilityBreakdown;
  claims: ExplainedClaim[];
  reasons: string[];
  caveats: string[];
}

export function explainJob(job: ExplainableJob): Explanation {
  const cohortSize = job.corroboration?.cohortSize ?? 0;
  const claims = job.claims.map((claim) => explainClaim(claim, cohortSize));

  const supported = claims.filter((claim) => claim.verdict === "SUPPORTED").length;
  const disputed = claims.filter((claim) => claim.verdict === "DISPUTED").length;
  const unsupported = claims.filter((claim) => claim.verdict === "UNSUPPORTED").length;

  const evidence =
    claims.length === 0
      ? 0
      : claims.reduce((sum, claim) => sum + claim.evidenceQuality, 0) / claims.length;
  const reasoning =
    job.evaluations.length === 0
      ? 0
      : job.evaluations.reduce((sum, row) => sum + row.overall, 0) / job.evaluations.length;

  const reasons: string[] = [];
  if (cohortSize > 0) {
    reasons.push(
      `${cohortSize} agent(s) analysed the same evidence pool independently, ` +
        `producing ${claims.length} merged claim(s).`,
    );
  }
  reasons.push(
    `${supported} claim(s) are supported, ${disputed} disputed, ${unsupported} unsupported.`,
  );
  reasons.push(
    `Evidence reliability ${evidence.toFixed(2)}, reasoning quality ${reasoning.toFixed(2)} ` +
      `from a deterministic evaluator — no model graded another model.`,
  );
  reasons.push(
    `Confidence ${pct(job.confidence)} and consensus ${pct(job.consensusScore)} are reported ` +
      `separately: a cohort can be confident and split.`,
  );

  // Independence belongs in the chain, not only in the caveats. When a cohort
  // did span vendors that is a reason the agreement means something, and a
  // reader who only ever sees it as a warning learns that models are a problem
  // rather than that this one was handled.
  const spread = job.independence;
  if (spread && !spread.unknown && spread.origins.length > 1) {
    reasons.push(
      `Its ${spread.distinctModels} model(s) came from ${spread.origins.length} vendors ` +
        `(${spread.effectiveOrigins.toFixed(1)} effective after weighting), so the agreement ` +
        `is not one model agreeing with itself.`,
    );
  }

  const caveats: string[] = [];
  if (job.corroboration?.short) {
    caveats.push(
      `Only ${job.corroboration.cohortSize} of ${job.corroboration.expected} agents finished, ` +
        `so the consensus score was discounted by ${job.corroboration.factor.toFixed(2)}.`,
    );
  }
  // A cohort's model mix is a caveat only when it is a limit on the result.
  // Stated as what it does to the reading, not as a score: this project has no
  // defensible coefficient for "how much less a shared model's agreement is
  // worth", and a made-up one would be quoted as though it did.
  if (spread?.unknown) {
    caveats.push(
      "The models behind this cohort were not recorded, so how independently these agents " +
        "could be wrong is unknown.",
    );
  } else if (spread?.monoculture && cohortSize > 1) {
    caveats.push(
      `All ${cohortSize} agents ran the same model (${spread.origins[0]?.origin ?? "one vendor"}), ` +
        `so their agreement reflects that shared model as well as the evidence.`,
    );
  } else if (spread && spread.origins.length === 1 && cohortSize > 1) {
    caveats.push(
      `Every model in this cohort came from ${spread.origins[0]?.origin}, so a blind spot in ` +
        `that vendor's training would be shared by all ${cohortSize} agents.`,
    );
  }
  if (job.disagreements.length > 0) {
    caveats.push(
      `${job.disagreements.length} topic(s) were left as open disagreements rather than averaged.`,
    );
  }
  if (unsupported > 0) {
    caveats.push(`${unsupported} claim(s) cited no retrieved evidence and were flagged.`);
  }
  if (job.minimumConfidence !== null && job.confidence < job.minimumConfidence) {
    caveats.push(
      `Confidence is below the ${pct(job.minimumConfidence)} floor this job asked for.`,
    );
  }

  return {
    // The job-level verdict follows the same rules as a claim: disputed beats
    // supported, and nothing supported means nothing to rely on.
    verdict:
      claims.length === 0
        ? "UNSUPPORTED"
        : disputed > supported
          ? "DISPUTED"
          : supported === 0
            ? "UNSUPPORTED"
            : cohortSize <= EXPLAIN_THRESHOLDS.LONE_AGENT
              ? "THIN"
              : "SUPPORTED",
    confidence: job.confidence,
    consensusScore: job.consensusScore,
    reliability: {
      evidence,
      reasoning,
      // Populated once predictions resolve; see docs/protocol.md.
      outcome: null,
    },
    claims,
    reasons,
    caveats,
  };
}

/**
 * The shape the merge writes into `ConsensusResult.claims`.
 *
 * Declared here rather than at the route because reading it is where the
 * upstream curation numbers are recovered, and that deserves a test that does
 * not need a database to run.
 */
export interface StoredEvidence {
  source: string;
  title?: string | null;
  reliability?: number;
  metadata?: Record<string, unknown>;
}

export interface StoredClaim {
  statement: string;
  kind: string;
  confidence?: number;
  support?: number;
  supportedBy?: string[];
  contradictedBy?: string[];
  supportingEvidence?: StoredEvidence[];
  contradictingEvidence?: StoredEvidence[];
}

/** Lifts the upstream curation out of a stored evidence row. */
export function evidenceFromStored(
  evidence: StoredEvidence,
  stance: "supports" | "contradicts",
): ExplainedEvidence {
  const meta = evidence.metadata ?? {};
  const upVotes = meta["upVotes"];
  const downVotes = meta["downVotes"];
  const approvalRate = meta["approvalRate"];
  const epoch = meta["epoch"];

  return {
    source: evidence.source,
    title: evidence.title ?? null,
    reliability: evidence.reliability ?? 0.5,
    stance,
    // Only Reppo-derived evidence carries vote volumes; an HTTP fetch has
    // none, and inventing a neutral pair would imply a curation that never
    // happened.
    curation:
      typeof upVotes === "number" && typeof downVotes === "number"
        ? {
            upVotes,
            downVotes,
            approvalRate: typeof approvalRate === "number" ? approvalRate : 0.5,
            epoch: typeof epoch === "number" ? epoch : null,
          }
        : null,
  };
}

export function claimFromStored(claim: StoredClaim): ExplainableClaim {
  return {
    statement: claim.statement,
    kind: claim.kind,
    confidence: claim.confidence ?? 0,
    support: claim.support ?? 0,
    supportedBy: claim.supportedBy ?? [],
    contradictedBy: claim.contradictedBy ?? [],
    evidence: [
      ...(claim.supportingEvidence ?? []).map((e) => evidenceFromStored(e, "supports")),
      ...(claim.contradictingEvidence ?? []).map((e) => evidenceFromStored(e, "contradicts")),
    ],
  };
}
