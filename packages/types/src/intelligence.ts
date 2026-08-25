import { z } from "zod";
import { UnitInterval } from "./common";
import { EvidenceSchema } from "./evidence";

export const ClaimKindSchema = z.enum([
  "FACT",
  "ASSESSMENT",
  "PREDICTION",
  "RISK",
  "RECOMMENDATION",
]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

/** Machine-checkable resolution spec attached to PREDICTION claims. */
export const ResolutionCriteriaSchema = z.object({
  metric: z.string(),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]),
  threshold: z.union([z.number(), z.string()]),
  /** Where the resolver should look, e.g. "coingecko:bitcoin/usd". */
  source: z.string(),
  deadline: z.string(),
});
export type ResolutionCriteria = z.infer<typeof ResolutionCriteriaSchema>;

export const ClaimSchema = z.object({
  /** One falsifiable assertion. Prose belongs in `summary`, not here. */
  statement: z.string().min(3),
  kind: ClaimKindSchema.default("ASSESSMENT"),
  confidence: UnitInterval,
  /** Indices into the output's `evidence` array that back this claim. */
  evidenceRefs: z.array(z.number().int().nonnegative()).default([]),
  /** Required when kind is PREDICTION, ignored otherwise. */
  resolution: ResolutionCriteriaSchema.optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const RiskSchema = z.object({
  description: z.string(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  likelihood: UnitInterval,
});
export type Risk = z.infer<typeof RiskSchema>;

export const RecommendationSchema = z.object({
  action: z.string(),
  rationale: z.string(),
  confidence: UnitInterval,
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

/**
 * The protocol's unit of intelligence. Agents return exactly this — never
 * free-form prose as the primary payload.
 */
export const StructuredIntelligenceSchema = z.object({
  summary: z.string().min(1),
  claims: z.array(ClaimSchema).min(1),
  evidence: z.array(EvidenceSchema).default([]),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  recommendation: RecommendationSchema.nullable().default(null),
  risks: z.array(RiskSchema).default([]),
  /** Confidence in the result as a whole, 0..1. */
  confidence: UnitInterval,
});
export type StructuredIntelligence = z.infer<typeof StructuredIntelligenceSchema>;

/**
 * Normalized claim fingerprint used to recognize when two agents made the
 * same claim in different words. Deliberately crude — it strips filler and
 * punctuation rather than attempting semantic matching, which belongs in a
 * pluggable clusterer, not in the type layer.
 */
const FILLER = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "of", "to", "in",
  "on", "for", "with", "that", "this", "it", "its", "as", "at", "by", "and",
  "or", "will", "may", "likely", "appears", "seems",
]);

export function claimFingerprint(statement: string): string {
  const tokens = statement
    .toLowerCase()
    .replace(/[^a-z0-9\s.%-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FILLER.has(t))
    .sort();
  return tokens.join("-").slice(0, 200);
}
