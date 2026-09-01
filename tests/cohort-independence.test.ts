import { describe, expect, it } from "vitest";
import {
  ConsensusEngine,
  effectiveOrigins,
  measureIndependence,
  modelIdentity,
  modelOrigin,
} from "@averis/consensus";
// Straight from the module, as tests/explain.test.ts does: the package index
// pulls in the database client, and this file needs neither.
import { explainJob, type ExplainableJob } from "../packages/protocol/src/explain";
import type { ConsensusInput } from "@averis/types";
import { claimFingerprint } from "@averis/types";

function agent(
  id: string,
  binding: [provider: string, model: string],
  claims: Array<[string, number]> = [["liquidity is thinning on the venue", 0.8]],
): ConsensusInput {
  return {
    outputId: `out-${id}`,
    agentId: id,
    agentName: `Agent ${id}`,
    summary: `summary ${id}`,
    confidence: 0.8,
    modelProvider: binding[0],
    modelName: binding[1],
    claims: claims.map(([statement, confidence]) => ({
      statement,
      kind: "ASSESSMENT" as const,
      confidence,
      fingerprint: claimFingerprint(statement),
      evidence: [],
    })),
    metrics: {},
    recommendation: null,
    risks: [],
    signals: {
      reputation: 0.5,
      domainReputation: 0.5,
      accuracy: 0.5,
      calibration: 0.5,
      evidenceQuality: 0.5,
      evaluation: null,
    },
  };
}

describe("resolving what actually answered", () => {
  it("takes a direct provider at its word", () => {
    expect(modelOrigin("anthropic", "claude-sonnet-5")).toBe("anthropic");
    expect(modelOrigin("  OpenAI  ", "gpt-5.1")).toBe("openai");
  });

  it("looks through a gateway to the vendor behind it", () => {
    // The whole point of routing through OpenRouter is that one credential
    // reaches many labs. Counting the credential would report three agents on
    // three different labs as a single-vendor cohort.
    expect(modelOrigin("openrouter", "google/gemini-3-pro")).toBe("google");
    expect(modelOrigin("openrouter", "anthropic/claude-sonnet-5")).toBe("anthropic");
  });

  it("stops at the gateway when the route names no vendor", () => {
    // `auto` picks a model at request time and does not record which. The
    // gateway is the most that is actually known.
    expect(modelOrigin("openrouter", "auto")).toBe("openrouter");
  });

  it("folds a vendor's aliases together", () => {
    // One lab reached two ways is one lab. Left unfolded this is the exact
    // error the module exists to catch, dressed as a diverse cohort.
    expect(modelOrigin("gemini", "gemini-3-pro")).toBe("google");
    expect(modelOrigin("openrouter", "google/gemini-3-pro")).toBe("google");
    expect(modelOrigin("openrouter", "meta-llama/llama-4-70b")).toBe("meta");
  });

  it("reports an unrecorded binding as unknown rather than as a vendor", () => {
    expect(modelOrigin("", "")).toBe("");
    expect(modelOrigin("   ", "gpt-5.1")).toBe("");
  });

  it("gives one model one identity however it was reached", () => {
    expect(modelIdentity("gemini", "gemini-3-pro")).toBe(
      modelIdentity("openrouter", "google/gemini-3-pro"),
    );
  });

  it("treats a billing variant as the same model", () => {
    expect(modelIdentity("openrouter", "meta-llama/llama-4-70b:free")).toBe(
      modelIdentity("openrouter", "meta-llama/llama-4-70b"),
    );
  });
});

describe("counting vendors by weight", () => {
  it("counts evenly spread weight as the plain number of vendors", () => {
    expect(effectiveOrigins([1 / 3, 1 / 3, 1 / 3])).toBeCloseTo(3, 6);
    expect(effectiveOrigins([0.5, 0.5])).toBeCloseTo(2, 6);
  });

  it("discounts vendors that carried almost none of the weight", () => {
    // Three names, one voice: the verdict is the heavy agent's, and a plain
    // count of 3 would say this cohort was three independent opinions.
    const effective = effectiveOrigins([0.9, 0.05, 0.05]);
    expect(effective).toBeGreaterThan(1);
    expect(effective).toBeLessThan(1.3);
  });

  it("never exceeds the number of vendors present", () => {
    expect(effectiveOrigins([0.7, 0.3])).toBeLessThan(2);
    expect(effectiveOrigins([1])).toBeCloseTo(1, 6);
  });
});

describe("measuring a cohort", () => {
  const even = (provider: string, model: string) => ({
    modelProvider: provider,
    modelName: model,
    weight: 1 / 3,
  });

  it("names a cohort that shares one model a monoculture", () => {
    const measured = measureIndependence([
      even("openai", "gpt-5.1"),
      even("openai", "gpt-5.1"),
      even("openai", "gpt-5.1"),
    ]);

    expect(measured.monoculture).toBe(true);
    expect(measured.distinctModels).toBe(1);
    expect(measured.origins).toEqual([{ origin: "openai", agents: 3, weight: 1 }]);
    expect(measured.effectiveOrigins).toBeCloseTo(1, 4);
  });

  it("does not call two models from one vendor a monoculture", () => {
    const measured = measureIndependence([
      even("openai", "gpt-5.1"),
      even("openai", "gpt-5.1-mini"),
      even("openai", "gpt-5.1"),
    ]);

    expect(measured.monoculture).toBe(false);
    expect(measured.distinctModels).toBe(2);
    // Still one vendor, which is the fact a reader needs.
    expect(measured.origins).toHaveLength(1);
  });

  it("sees through a gateway when counting vendors", () => {
    const measured = measureIndependence([
      even("openrouter", "google/gemini-3-pro"),
      even("openrouter", "anthropic/claude-sonnet-5"),
      even("openrouter", "openai/gpt-5.1"),
    ]);

    expect(measured.monoculture).toBe(false);
    expect(measured.origins.map((row) => row.origin).sort()).toEqual([
      "anthropic",
      "google",
      "openai",
    ]);
    expect(measured.effectiveOrigins).toBeCloseTo(3, 4);
  });

  it("does not credit a lab reached two ways as two vendors", () => {
    const measured = measureIndependence([
      { modelProvider: "gemini", modelName: "gemini-3-pro", weight: 0.5 },
      { modelProvider: "openrouter", modelName: "google/gemini-3-pro", weight: 0.5 },
    ]);

    expect(measured.origins).toEqual([{ origin: "google", agents: 2, weight: 1 }]);
    expect(measured.monoculture).toBe(true);
  });

  it("ranks origins by the weight they carried, not by how many agents", () => {
    const measured = measureIndependence([
      { modelProvider: "openai", modelName: "gpt-5.1", weight: 0.1 },
      { modelProvider: "openai", modelName: "gpt-5.1", weight: 0.1 },
      { modelProvider: "anthropic", modelName: "claude-sonnet-5", weight: 0.8 },
    ]);

    expect(measured.origins[0]?.origin).toBe("anthropic");
    expect(measured.largestOriginShare).toBeCloseTo(0.8, 4);
    // Two of three agents were OpenAI, and the cohort is still not two
    // independent voices — the verdict is mostly one agent's.
    expect(measured.effectiveOrigins).toBeLessThan(1.5);
  });

  it("refuses to describe a cohort whose bindings were never recorded", () => {
    const measured = measureIndependence([
      { modelProvider: "", modelName: "", weight: 0.5 },
      { modelProvider: "openai", modelName: "gpt-5.1", weight: 0.5 },
    ]);

    expect(measured.unknown).toBe(true);
    // One recorded binding is not evidence that the cohort was uniform.
    expect(measured.monoculture).toBe(false);
  });

  it("does not call a lone agent a monoculture", () => {
    // Corroboration already reports that nothing was corroborated. Saying it
    // again in model terms reads as a second, independent problem.
    const measured = measureIndependence([
      { modelProvider: "openai", modelName: "gpt-5.1", weight: 1 },
    ]);
    expect(measured.monoculture).toBe(false);
  });
});

describe("the merged result carries the cohort it came from", () => {
  const engine = new ConsensusEngine();
  const claims: Array<[string, number]> = [
    ["liquidity is thinning on the venue", 0.8],
    ["funding has stayed positive for three days", 0.7],
  ];

  const mono = [
    agent("a", ["openai", "gpt-5.1"], claims),
    agent("b", ["openai", "gpt-5.1"], claims),
    agent("c", ["openai", "gpt-5.1"], claims),
  ];
  const mixed = [
    agent("a", ["openai", "gpt-5.1"], claims),
    agent("b", ["anthropic", "claude-sonnet-5"], claims),
    agent("c", ["openrouter", "google/gemini-3-pro"], claims),
  ];

  it("reports the vendors behind a merged result", () => {
    const outcome = engine.run(mixed);
    expect(outcome.independence.origins).toHaveLength(3);
    expect(outcome.independence.monoculture).toBe(false);
    expect(outcome.independence.distinctModels).toBe(3);
  });

  it("records on each contribution what produced it", () => {
    const outcome = engine.run(mixed);
    const routed = outcome.contributions.find((row) => row.agentId === "c");
    expect(routed?.modelProvider).toBe("openrouter");
    expect(routed?.modelOrigin).toBe("google");
  });

  it("scores agreement the same either way", () => {
    // The design decision, pinned. Two cohorts that said exactly the same
    // things agree exactly as much, and `consensusScore` stays a measurement
    // of agreement rather than a blend of agreement and how much it is worth.
    // If a coefficient is ever folded in, this is the test that should be
    // argued with first.
    const uniform = engine.run(mono);
    const diverse = engine.run(mixed);

    expect(uniform.consensusScore).toBeCloseTo(diverse.consensusScore, 10);
    expect(uniform.confidence).toBeCloseTo(diverse.confidence, 10);
  });

  it("says in the summary which of the two it was", () => {
    expect(engine.run(mono).summary).toMatch(/Every agent ran the same model \(openai\)/);
    expect(engine.run(mixed).summary).toMatch(/spanned 3 vendors/);
  });

  it("says nothing about vendors when there was only one agent", () => {
    // A cohort of one is already reported as uncorroborated; the model it ran
    // on adds no further caution and would only dilute that sentence.
    const solo = engine.run([agent("a", ["openai", "gpt-5.1"], claims)], {
      expectedCohortSize: 3,
    });
    expect(solo.summary).not.toMatch(/vendor|same model/);
  });
});

describe("the explanation states the limit rather than scoring it", () => {
  const base = (
    independence: ExplainableJob["independence"],
    cohortSize = 3,
  ): ExplainableJob => ({
    confidence: 0.8,
    consensusScore: 0.9,
    minimumConfidence: null,
    corroboration: { cohortSize, expected: cohortSize, factor: 1, short: false },
    independence,
    claims: [
      {
        statement: "liquidity is thinning",
        kind: "ASSESSMENT",
        confidence: 0.8,
        support: 0.9,
        supportedBy: ["a", "b", "c"],
        contradictedBy: [],
        evidence: [
          { source: "reppo://pod/1", title: null, reliability: 0.9, stance: "supports", curation: null },
        ],
      },
    ],
    disagreements: [],
    evaluations: [{ agentName: "Agent a", overall: 0.8 }],
  });

  it("warns when every agent ran the same model", () => {
    const explanation = explainJob(
      base({
        origins: [{ origin: "openai", agents: 3, weight: 1 }],
        effectiveOrigins: 1,
        distinctModels: 1,
        monoculture: true,
        unknown: false,
      }),
    );

    expect(explanation.caveats.join(" ")).toContain("All 3 agents ran the same model (openai)");
  });

  it("warns when the models differ but the vendor does not", () => {
    const explanation = explainJob(
      base({
        origins: [{ origin: "openai", agents: 3, weight: 1 }],
        effectiveOrigins: 1,
        distinctModels: 2,
        monoculture: false,
        unknown: false,
      }),
    );

    expect(explanation.caveats.join(" ")).toContain("came from openai");
  });

  it("counts a spread of vendors as a reason the agreement holds", () => {
    const explanation = explainJob(
      base({
        origins: [
          { origin: "openai", agents: 1, weight: 0.34 },
          { origin: "anthropic", agents: 1, weight: 0.33 },
          { origin: "google", agents: 1, weight: 0.33 },
        ],
        effectiveOrigins: 3,
        distinctModels: 3,
        monoculture: false,
        unknown: false,
      }),
    );

    expect(explanation.reasons.join(" ")).toContain("3 vendors");
    expect(explanation.caveats.join(" ")).not.toContain("vendor");
  });

  it("says the cohort is unmeasured rather than uniform when it was not recorded", () => {
    const explanation = explainJob(
      base({
        origins: [],
        effectiveOrigins: 0,
        distinctModels: 0,
        monoculture: false,
        unknown: true,
      }),
    );

    expect(explanation.caveats.join(" ")).toContain("were not recorded");
  });

  it("leaves a job that predates the measurement alone", () => {
    const explanation = explainJob(base(null));
    const text = `${explanation.reasons.join(" ")} ${explanation.caveats.join(" ")}`;
    expect(text).not.toContain("vendor");
    expect(text).not.toContain("ran the same model");
    expect(text).not.toContain("were not recorded");
  });

  it("does not change the verdict", () => {
    // Independence is reported, never scored. A monoculture that produced a
    // well-evidenced, uncontested claim still reads as SUPPORTED, and it is
    // the caveat — not a silently lowered verdict — that tells the reader why
    // to weigh it less.
    const uniform = explainJob(
      base({
        origins: [{ origin: "openai", agents: 3, weight: 1 }],
        effectiveOrigins: 1,
        distinctModels: 1,
        monoculture: true,
        unknown: false,
      }),
    );
    expect(uniform.verdict).toBe("SUPPORTED");
  });
});
