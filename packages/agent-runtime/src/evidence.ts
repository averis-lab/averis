import { evidenceFingerprint, type Evidence, type EvidenceType } from "@averis/types";

export interface EvidenceDraft {
  type: EvidenceType;
  source: string;
  title?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown>;
  reliability?: number;
  timestamp?: Date;
}

/**
 * Collects evidence during a single agent run.
 *
 * Evidence is recorded by the *tool runtime*, never by the model. An agent can
 * only cite what a tool actually retrieved, which is what makes a claim's
 * provenance verifiable rather than asserted. The model's only influence is
 * choosing which recorded item to point a claim at.
 *
 * Deduplication is by content hash, so two tools returning the same upstream
 * item yield one evidence row and one stable index.
 */
export class EvidenceCollector {
  private readonly byHash = new Map<string, number>();
  private readonly rows: Evidence[] = [];

  constructor(private readonly runId: string) {}

  /** Records evidence and returns its stable index for claim references. */
  record(draft: EvidenceDraft): number {
    const contentHash = evidenceFingerprint(draft.source, draft.content ?? null);
    const existing = this.byHash.get(contentHash);
    if (existing !== undefined) return existing;

    const index = this.rows.length;
    this.rows.push({
      id: `${this.runId}:${index}`,
      type: draft.type,
      source: draft.source,
      title: draft.title ?? null,
      content: draft.content ?? null,
      metadata: { ...(draft.metadata ?? {}), contentHash },
      reliability: clamp01(draft.reliability ?? 0.5),
      timestamp: draft.timestamp ?? new Date(),
    });
    this.byHash.set(contentHash, index);
    return index;
  }

  all(): Evidence[] {
    return [...this.rows];
  }

  get size(): number {
    return this.rows.length;
  }

  /**
   * Resolves model-supplied references to real evidence, dropping any index
   * that does not exist. A model cannot invent provenance by citing an index
   * that was never collected.
   */
  resolve(refs: number[]): Evidence[] {
    const seen = new Set<number>();
    const resolved: Evidence[] = [];
    for (const ref of refs) {
      if (!Number.isInteger(ref) || ref < 0 || ref >= this.rows.length) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      resolved.push(this.rows[ref]!);
    }
    return resolved;
  }

  /** Mean reliability of the cited evidence; 0 when a claim cites nothing. */
  reliabilityOf(refs: number[]): number {
    const resolved = this.resolve(refs);
    if (resolved.length === 0) return 0;
    return resolved.reduce((acc, e) => acc + e.reliability, 0) / resolved.length;
  }
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
