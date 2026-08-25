import type { ConsensusInput } from "@averis/types";
import { contentSet, polarity, similarity } from "./text";

export interface ClaimRef {
  outputId: string;
  agentId: string;
  agentName: string;
  claimIndex: number;
  statement: string;
  kind: ConsensusInput["claims"][number]["kind"];
  confidence: number;
  fingerprint: string;
  evidence: ConsensusInput["claims"][number]["evidence"];
  /** +1 asserts, -1 denies, 0 neutral. */
  stance: -1 | 0 | 1;
  tokens: Set<string>;
}

/** A topic: claims about the same thing, which may take opposing stances. */
export interface ClaimCluster {
  members: ClaimRef[];
  /** Union of member tokens, used as the cluster centroid. */
  centroid: Set<string>;
}

/**
 * Groups claims that are about the same subject.
 *
 * Replaceable: swap in an embedding-backed implementation without touching
 * the merge logic, which only consumes `ClaimCluster[]`.
 */
export interface ClaimClusterer {
  readonly name: string;
  cluster(claims: ClaimRef[]): ClaimCluster[];
}

export interface LexicalClustererConfig {
  /**
   * Token-overlap threshold above which two claims are treated as the same
   * topic. 0.4 is deliberately permissive: a missed cluster means a real
   * disagreement is silently reported as two separate agreed claims, which is
   * the more dangerous failure of the two.
   */
  similarityThreshold?: number;
}

export class LexicalClusterer implements ClaimClusterer {
  readonly name = "lexical-jaccard";
  private readonly threshold: number;

  constructor(config: LexicalClustererConfig = {}) {
    this.threshold = config.similarityThreshold ?? 0.4;
  }

  cluster(claims: ClaimRef[]): ClaimCluster[] {
    const clusters: ClaimCluster[] = [];

    // Deterministic input order — identical cohorts must merge identically.
    const ordered = [...claims].sort(
      (a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.outputId.localeCompare(b.outputId),
    );

    for (const claim of ordered) {
      let best: { cluster: ClaimCluster; score: number } | null = null;

      for (const cluster of clusters) {
        // An exact fingerprint match is the same claim, full stop.
        const exact = cluster.members.some((m) => m.fingerprint === claim.fingerprint);
        const score = exact ? 1 : similarity(claim.tokens, cluster.centroid);
        if (score >= this.threshold && (best === null || score > best.score)) {
          best = { cluster, score };
        }
      }

      if (best) {
        best.cluster.members.push(claim);
        for (const token of claim.tokens) best.cluster.centroid.add(token);
      } else {
        clusters.push({ members: [claim], centroid: new Set(claim.tokens) });
      }
    }

    return clusters;
  }
}

export function toClaimRefs(inputs: ConsensusInput[]): ClaimRef[] {
  return inputs.flatMap((input) =>
    input.claims.map((claim, claimIndex) => ({
      outputId: input.outputId,
      agentId: input.agentId,
      agentName: input.agentName,
      claimIndex,
      statement: claim.statement,
      kind: claim.kind,
      confidence: claim.confidence,
      fingerprint: claim.fingerprint,
      evidence: claim.evidence,
      stance: polarity(claim.statement),
      tokens: contentSet(claim.statement),
    })),
  );
}
