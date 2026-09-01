import type { CohortIndependence, ConsensusInput, OriginShare } from "@averis/types";

/**
 * How independent a cohort's voices were, in model terms.
 *
 * The engine already discounts a cohort that was too small to corroborate
 * itself. This is the same question asked of a cohort that is large enough:
 * were those agents actually different, or were they one model wearing five
 * names? Correlated model error is the main failure mode of a single-vendor
 * cohort — the provider factory says so, and the registry seed says so — and
 * until now nothing in the pipeline measured it.
 *
 * Nothing here touches which claims survive or what the score is. It is a
 * description of the cohort, computed after the weights are known and reported
 * beside the result; see {@link CohortIndependence} for why it deliberately
 * carries no multiplier.
 */

/**
 * Providers that are routes, not vendors.
 *
 * A gateway is the one case where the provider name is actively misleading
 * about independence: three agents on `openrouter` reaching Anthropic, Google
 * and OpenAI are three origins, and three reaching the same model are one.
 * Counting the credential instead of the vendor would get both backwards.
 */
const GATEWAYS = new Set(["openrouter"]);

/**
 * Names for the same vendor, folded together.
 *
 * This is not cosmetic. Gemini reached natively is `gemini`, and reached
 * through a gateway is `google/…`; left unfolded, one lab would be counted as
 * two independent origins — the precise error this module exists to catch.
 */
const VENDOR_ALIASES: Record<string, string> = {
  gemini: "google",
  "google-vertex": "google",
  "x-ai": "xai",
  "meta-llama": "meta",
  mistralai: "mistral",
};

const canonical = (vendor: string): string => VENDOR_ALIASES[vendor] ?? vendor;

/**
 * The vendor whose model actually answered.
 *
 * For a direct provider that is the provider itself. For a gateway it is the
 * namespace of the model id — `google/gemini-3-pro` is Google's model however
 * it was billed. A gateway route with no namespace (`auto`, and anything else
 * that picks a model at request time) resolves to the gateway, because what
 * answered is genuinely not recorded and inventing a vendor would be worse
 * than admitting the route.
 *
 * Returns `""` when the binding was never recorded, which callers must treat
 * as unknown rather than as an origin of its own.
 */
export function modelOrigin(provider: string, model: string): string {
  const kind = provider.trim().toLowerCase();
  if (!kind) return "";
  if (!GATEWAYS.has(kind)) return canonical(kind);

  const namespace = model.trim().toLowerCase().split("/")[0] ?? "";
  return namespace && model.includes("/") ? canonical(namespace) : kind;
}

/**
 * A model identity that survives the route it arrived by.
 *
 * `gemini` + `gemini-3-pro` and `openrouter` + `google/gemini-3-pro` are one
 * model, so a cohort split across a gateway and a direct key is not credited
 * with two. Variant suffixes (`:free`, `:nitro`) are the same weights served
 * on different terms and are dropped.
 */
export function modelIdentity(provider: string, model: string): string {
  const origin = modelOrigin(provider, model);
  const segments = model.trim().toLowerCase().split("/");
  const leaf = (segments[segments.length - 1] ?? "").split(":")[0] ?? "";
  return `${origin}/${leaf}`;
}

/**
 * Vendor count, weighted.
 *
 * The inverse Simpson index: one over the sum of squared shares. Three vendors
 * holding a third each score 3; three where one holds 90% score 1.2, which is
 * the honest reading — the verdict is that one agent's view with two
 * bystanders. Equal to the plain count only when the weight is spread evenly,
 * and never above it.
 */
export function effectiveOrigins(shares: number[]): number {
  const total = shares.reduce((sum, share) => sum + share, 0);
  if (total <= 0) return shares.length > 0 ? 1 : 0;

  const concentration = shares.reduce((sum, share) => sum + (share / total) ** 2, 0);
  return concentration > 0 ? 1 / concentration : 0;
}

/** One row per contributing agent: what it ran on, and what it carried. */
export interface IndependenceRow {
  modelProvider: string;
  modelName: string;
  /** Normalized weight this agent carried in the merge. */
  weight: number;
}

export function independenceRowsFrom(
  inputs: ConsensusInput[],
  weightOf: (outputId: string) => number,
): IndependenceRow[] {
  return inputs.map((input) => ({
    modelProvider: input.modelProvider,
    modelName: input.modelName,
    weight: weightOf(input.outputId),
  }));
}

/**
 * Measures the cohort behind a merged result.
 *
 * Unrecorded bindings are reported, never guessed. A job that ran before the
 * binding was persisted has no origins to show, and saying "one vendor" about
 * it would be a claim the data does not support — the same rule the rest of
 * this protocol applies to evidence.
 */
export function measureIndependence(rows: IndependenceRow[]): CohortIndependence {
  const unknown = rows.some((row) => !row.modelProvider.trim() || !row.modelName.trim());

  const byOrigin = new Map<string, { agents: number; weight: number }>();
  const identities = new Set<string>();

  for (const row of rows) {
    const origin = modelOrigin(row.modelProvider, row.modelName);
    if (!origin) continue;

    identities.add(modelIdentity(row.modelProvider, row.modelName));
    const bucket = byOrigin.get(origin) ?? { agents: 0, weight: 0 };
    bucket.agents += 1;
    bucket.weight += Math.max(0, row.weight);
    byOrigin.set(origin, bucket);
  }

  const totalWeight = [...byOrigin.values()].reduce((sum, bucket) => sum + bucket.weight, 0);
  const origins: OriginShare[] = [...byOrigin.entries()]
    // Share of the weight that was actually counted, so the column sums to 1
    // even when a strategy hands out weights that do not.
    .map(([origin, bucket]) => ({
      origin,
      agents: bucket.agents,
      weight: totalWeight > 0 ? round(bucket.weight / totalWeight) : round(bucket.agents / rows.length),
    }))
    .sort((a, b) => b.weight - a.weight || a.origin.localeCompare(b.origin));

  return {
    origins,
    effectiveOrigins: round(effectiveOrigins(origins.map((row) => row.weight))),
    largestOriginShare: origins[0]?.weight ?? 0,
    distinctModels: identities.size,
    // A lone agent is not a monoculture. Corroboration already reports that
    // nothing was corroborated, and saying it twice in different words reads
    // as two independent problems.
    monoculture: !unknown && rows.length > 1 && identities.size === 1,
    unknown,
  };
}

/**
 * The sentence the summary carries, or null when there is nothing to add.
 *
 * Kept beside the measurement rather than in the engine so the wording and the
 * numbers cannot drift apart.
 */
export function describeIndependence(independence: CohortIndependence, cohortSize: number): string | null {
  if (cohortSize <= 1) return null;
  if (independence.unknown) {
    return "The models behind this cohort were not recorded, so how independent these agents were is unknown.";
  }
  if (independence.monoculture) {
    const only = independence.origins[0]?.origin ?? "one vendor";
    return `Every agent ran the same model (${only}), so this agreement is partly a property of that model rather than of the evidence.`;
  }
  if (independence.origins.length === 1) {
    return `All ${independence.distinctModels} models came from one vendor (${independence.origins[0]?.origin}), which limits how independently this cohort could be wrong.`;
  }

  return `The cohort spanned ${independence.origins.length} vendors (${independence.effectiveOrigins.toFixed(1)} effective after weighting), so agreement here survived more than one model's blind spots.`;
}

function round(n: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}
