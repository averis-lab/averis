import { z } from "zod";
import { Timestamp, UnitInterval } from "./common";

export const EvidenceTypeSchema = z.enum([
  "REPPO_POD",
  "REPPO_DATANET",
  "ONCHAIN",
  "HTTP_API",
  "WEB",
  "DOCUMENT",
  "COMPUTATION",
  "PRIOR_INTELLIGENCE",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

/**
 * A provenance record. Every claim the protocol accepts must point at one or
 * more of these; an unsupported claim is downweighted, not silently trusted.
 */
export const EvidenceSchema = z.object({
  id: z.string(),
  type: EvidenceTypeSchema,
  /**
   * Canonical locator. For Reppo data this is `reppo://pod/<id>` or
   * `reppo://datanet/<id>` so provenance survives even if the URL rots.
   */
  source: z.string(),
  title: z.string().nullable().default(null),
  content: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /**
   * How much this source is worth, 0..1. For Reppo evidence this is derived
   * from the datanet's stake-backed curation vote, not asserted by the agent.
   */
  reliability: UnitInterval.default(0.5),
  timestamp: Timestamp,
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** Stable content hash used to deduplicate evidence across agents. */
export function evidenceFingerprint(source: string, content: string | null | undefined): string {
  const basis = `${source}\n${(content ?? "").trim()}`;
  // FNV-1a 64-bit — deterministic, dependency-free, sufficient for dedup.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < basis.length; i++) {
    hash ^= BigInt(basis.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
