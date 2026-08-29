import { describe, expect, it } from "vitest";
import {
  ConsensusEngine,
  LexicalClusterer,
  MultiFactorWeighting,
  UniformWeighting,
  polarity,
  jaccard,
  contentSet,
  similarity,
} from "@averis/consensus";
import type { ConsensusInput, Evidence } from "@averis/types";
import { claimFingerprint } from "@averis/types";

function evidence(id: string, reliability = 0.8): Evidence {
  return {
    id,
    type: "REPPO_POD",
    source: `reppo://pod/${id}`,
    title: id,
    content: `content-${id}`,
    metadata: {},
    reliability,
    timestamp: new Date("2026-08-01T00:00:00Z"),
  };
}

function agent(
  id: string,
  claims: Array<[string, number]>,
  signals: Partial<ConsensusInput["signals"]> = {},
  confidence = 0.8,
  // Defaults to the binding the seeded registry ships with, so a cohort built
  // by these helpers is the same monoculture the reference demo runs.
  binding: { modelProvider: string; modelName: string } = {
    modelProvider: "mock",
    modelName: "mock-analyst",
  },
): ConsensusInput {
  return {
    outputId: `out-${id}`,
    agentId: id,
    agentName: `Agent ${id}`,
    summary: `summary ${id}`,
    confidence,
    ...binding,
    claims: claims.map(([statement, c]) => ({
      statement,
      kind: "ASSESSMENT" as const,
      confidence: c,
      fingerprint: claimFingerprint(statement),
      evidence: [evidence(`${id}-e`)],
    })),
    metrics: { score: 10 },
    recommendation: { action: `act-${id}`, rationale: "because", confidence: 0.7 },
    risks: [],
    signals: {
      reputation: 0.5,
      domainReputation: 0.5,
      accuracy: 0.5,
      calibration: 0.5,
      evidenceQuality: 0.5,
      evaluation: null,
      ...signals,
    },
  };
}

describe("polarity detection", () => {
  it("reads assertion and denial", () => {
    expect(polarity("Liquidity is reliable and corroborated by curators")).toBe(1);
    expect(polarity("Liquidity is unreliable and contested by curators")).toBe(-1);
    expect(polarity("The corpus contains 12 items")).toBe(0);
  });

  it("inverts sentiment following a negator", () => {
    expect(polarity("The signal is not reliable")).toBe(-1);
  });
});

describe("weighting strategies", () => {
  const cohort = [
    agent("a", [["x", 0.8]], { domainReputation: 0.95, accuracy: 0.95 }),
    agent("b", [["x", 0.8]], { domainReputation: 0.5, accuracy: 0.5 }),
    agent("c", [["x", 0.8]], { domainReputation: 0.2, accuracy: 0.2 }),
  ];

  it("uniform weighting splits evenly and sums to one", () => {
    const weights = new UniformWeighting().weigh(cohort);
    expect(weights.map((w) => w.weight)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("multi-factor weighting orders by performance and sums to one", () => {
    const weights = new MultiFactorWeighting().weigh(cohort);
    const total = weights.reduce((acc, w) => acc + w.weight, 0);
    expect(total).toBeCloseTo(1, 6);
    expect(weights[0]!.weight).toBeGreaterThan(weights[1]!.weight);
    expect(weights[1]!.weight).toBeGreaterThan(weights[2]!.weight);
  });

  it("caps any single agent so one reputation cannot dominate the cohort", () => {
    const lopsided = [
      agent("star", [["x", 0.9]], {
        domainReputation: 1, accuracy: 1, calibration: 1, evidenceQuality: 1,
      }),
      agent("new", [["x", 0.5]], {
        domainReputation: 0.01, accuracy: 0.01, calibration: 0.01, evidenceQuality: 0.01,
      }),
      agent("new2", [["x", 0.5]], {
        domainReputation: 0.01, accuracy: 0.01, calibration: 0.01, evidenceQuality: 0.01,
      }),
    ];
    const weights = new MultiFactorWeighting({ maxShare: 0.5, minShare: 0.05 }).weigh(lopsided);
    const total = weights.reduce((acc, w) => acc + w.weight, 0);

    expect(total).toBeCloseTo(1, 6);
    for (const w of weights) {
      expect(w.weight).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(w.weight).toBeGreaterThanOrEqual(0.05 - 1e-6);
    }
  });

  it("gives a sole agent full weight", () => {
    const weights = new MultiFactorWeighting().weigh([cohort[0]!]);
    expect(weights).toHaveLength(1);
    expect(weights[0]!.weight).toBe(1);
  });

  it("weights self-reported confidence least, since it is free to inflate", () => {
    const strategy = new MultiFactorWeighting();
    const factors = (strategy.config as { factors: Record<string, number> }).factors;
    const others = Object.entries(factors).filter(([k]) => k !== "selfConfidence");
    for (const [, value] of others) {
      expect(factors["selfConfidence"]).toBeLessThan(value);
    }
  });
});

describe("consensus engine", () => {
  const engine = new ConsensusEngine();

  it("merges the same claim asserted by several agents into one", () => {
    const statement = "Curated liquidity depth is sufficient for execution";
    const outcome = engine.run([
      agent("a", [[statement, 0.9]]),
      agent("b", [[statement, 0.7]]),
      agent("c", [[statement, 0.8]]),
    ]);

    expect(outcome.claims).toHaveLength(1);
    expect(outcome.claims[0]!.supportedBy.sort()).toEqual(["a", "b", "c"]);
    expect(outcome.claims[0]!.support).toBeCloseTo(1, 4);
    expect(outcome.consensusScore).toBeGreaterThan(0.8);
  });

  it("surfaces a genuine split instead of averaging it away", () => {
    const outcome = engine.run([
      agent("a", [["The curated signal is reliable and corroborated", 0.9]]),
      agent("b", [["The curated signal is reliable and corroborated", 0.85]]),
      agent("c", [["The curated signal is not reliable and is contested", 0.8]]),
    ]);

    expect(outcome.disagreements.length).toBeGreaterThan(0);
    const claim = outcome.claims[0]!;
    expect(claim.contradictedBy).toContain("c");
    // The reported claim is one an agent actually made, not a blend.
    expect(["The curated signal is reliable and corroborated"]).toContain(claim.statement);
    // A contested cohort must not present as fully confident.
    expect(outcome.consensusScore).toBeLessThan(0.9);
  });

  it("reports confidence and consensus as independent quantities", () => {
    const agreed = engine.run([
      agent("a", [["Depth is sufficient", 0.9]]),
      agent("b", [["Depth is sufficient", 0.9]]),
    ]);
    const split = engine.run([
      agent("a", [["The signal is reliable and corroborated", 0.9]]),
      agent("b", [["The signal is not reliable and is contested", 0.9]]),
    ]);

    // Same stated confidence on both sides, but a split cohort is discounted.
    expect(split.confidence).toBeLessThan(agreed.confidence);
  });

  it("drops a claim only one low-weight agent asserted", () => {
    const outcome = new ConsensusEngine({ minSupport: 0.5 }).run([
      agent("a", [["Shared finding about liquidity depth", 0.9]]),
      agent("b", [["Shared finding about liquidity depth", 0.9]]),
      agent("c", [["Entirely unrelated speculative assertion regarding robotics telemetry", 0.9]]),
    ]);

    const statements = outcome.claims.map((c) => c.statement);
    expect(statements).toContain("Shared finding about liquidity depth");
    expect(statements).not.toContain(
      "Entirely unrelated speculative assertion regarding robotics telemetry",
    );
  });

  it("keeps both sides' evidence on a contested claim", () => {
    const outcome = engine.run([
      agent("a", [["The signal is reliable and corroborated", 0.9]]),
      agent("b", [["The signal is reliable and corroborated", 0.9]]),
      agent("c", [["The signal is not reliable and is contested", 0.9]]),
    ]);
    const claim = outcome.claims[0]!;
    expect(claim.supportingEvidence.length).toBeGreaterThan(0);
    expect(claim.contradictingEvidence.length).toBeGreaterThan(0);
  });

  it("produces contributions that sum to one and explain each weight", () => {
    const outcome = engine.run([
      agent("a", [["x claim about depth", 0.8]]),
      agent("b", [["x claim about depth", 0.8]]),
      agent("c", [["x claim about depth", 0.8]]),
    ]);
    const total = outcome.contributions.reduce((acc, c) => acc + c.weight, 0);
    expect(total).toBeCloseTo(1, 6);
    for (const c of outcome.contributions) {
      expect(Object.keys(c.breakdown).length).toBeGreaterThan(0);
      expect(c.agreement).toBeGreaterThanOrEqual(0);
      expect(c.agreement).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic across runs and independent of agent ordering", () => {
    const cohort = [
      agent("a", [["Depth is sufficient for execution", 0.9]]),
      agent("b", [["Depth is sufficient for execution", 0.7]]),
      agent("c", [["Volume declined over the last epoch", 0.6]]),
    ];
    const first = engine.run(cohort);
    const second = engine.run([...cohort].reverse());

    expect(first.claims.map((c) => c.statement)).toEqual(second.claims.map((c) => c.statement));
    expect(first.confidence).toBeCloseTo(second.confidence, 10);
    expect(first.consensusScore).toBeCloseTo(second.consensusScore, 10);
  });

  it("takes the worst severity when agents rate the same risk differently", () => {
    const withRisks = (id: string, severity: "LOW" | "CRITICAL"): ConsensusInput => ({
      ...agent(id, [["shared claim", 0.8]]),
      risks: [{ description: "Liquidity may evaporate", severity, likelihood: 0.5 }],
    });
    const outcome = engine.run([withRisks("a", "LOW"), withRisks("b", "CRITICAL")]);
    expect(outcome.risks[0]!.severity).toBe("CRITICAL");
  });

  it("rejects an empty cohort rather than inventing a result", () => {
    expect(() => engine.run([])).toThrow(/at least one/);
  });

  it("records which strategy produced the result, for auditability", () => {
    const outcome = engine.run([agent("a", [["claim", 0.8]])]);
    expect(outcome.strategy).toBe("multi-factor-v1");
    expect(outcome.strategyConfig["clusterer"]).toBe("lexical-jaccard");
  });
});

describe("claim clustering", () => {
  it("groups restatements of the same claim", () => {
    const clusterer = new LexicalClusterer();
    const a = contentSet("Curator approval rate is above sixty percent");
    const b = contentSet("Curators approval rates are above sixty percent");
    expect(jaccard(a, b)).toBeGreaterThan(0.6);
    expect(clusterer.name).toBe("lexical-jaccard");
  });
});

describe("regressions", () => {
  const engine = new ConsensusEngine();

  it("counts an agent's weight once even when it restates a claim", () => {
    // Two phrasings of the same position from one agent must not double its
    // voice — this previously produced 200% support on a two-agent cohort.
    const verbose: ConsensusInput = {
      ...agent("a", [["Curated liquidity depth is sufficient for execution", 0.9]]),
      claims: [
        {
          statement: "Curated liquidity depth is sufficient for execution",
          kind: "ASSESSMENT", confidence: 0.9,
          fingerprint: claimFingerprint("Curated liquidity depth is sufficient for execution"),
          evidence: [evidence("a-1")],
        },
        {
          statement: "Curated liquidity depth is sufficient for execution today",
          kind: "ASSESSMENT", confidence: 0.85,
          fingerprint: claimFingerprint("Curated liquidity depth is sufficient for execution today"),
          evidence: [evidence("a-2")],
        },
      ],
    };

    const outcome = engine.run([
      verbose,
      agent("b", [["Curated liquidity depth is sufficient for execution", 0.8]]),
    ]);

    for (const claim of outcome.claims) {
      expect(claim.support).toBeLessThanOrEqual(1 + 1e-6);
      expect(claim.supportedBy.length).toBeLessThanOrEqual(2);
    }
    expect(outcome.confidence).toBeLessThanOrEqual(1);
  });

  it("keeps support within [0,1] for every claim in a mixed cohort", () => {
    const outcome = engine.run([
      agent("a", [["Depth is sufficient", 0.9], ["Volume declined over the epoch", 0.6]]),
      agent("b", [["Depth is sufficient", 0.8]]),
      agent("c", [["The signal is not reliable and is contested", 0.7]]),
    ]);
    for (const claim of outcome.claims) {
      expect(claim.support).toBeGreaterThanOrEqual(0);
      expect(claim.support).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it("matches a claim against a longer elaboration of the same claim", () => {
    // Plain Jaccard scores this pair at 0.375 and would miss the conflict.
    const a = contentSet("The curated signal is reliable and corroborated");
    const b = contentSet("The curated signal is not reliable and is contested at 42.1% approval");
    expect(jaccard(a, b)).toBeLessThan(0.4);
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.4);
  });
});

describe("corroboration breadth", () => {
  const engine = new ConsensusEngine();
  const cohort = (n: number) =>
    Array.from({ length: n }, (_, i) => agent(`a${i}`, [["Depth is sufficient for execution", 0.8]]));

  it("gives a lone agent no consensus at all", () => {
    // One agent agreeing with itself is not corroboration, and reporting it as
    // 100% consensus told the reader several analysts had converged.
    const outcome = engine.run(cohort(1), { expectedCohortSize: 3 });

    expect(outcome.consensusScore).toBe(0);
    expect(outcome.corroboration).toEqual({
      cohortSize: 1,
      expected: 3,
      factor: 0,
      short: true,
    });
  });

  it("says plainly in the summary that nothing was corroborated", () => {
    const outcome = engine.run(cohort(1), { expectedCohortSize: 3 });
    expect(outcome.summary).toMatch(/Only 1 of 3 agents/);
    expect(outcome.summary).toMatch(/nothing here is corroborated by a second analyst/);
    expect(outcome.summary).toMatch(/no consensus/);
  });

  it("scores a full cohort above a short one that agreed just as hard", () => {
    const full = engine.run(cohort(3), { expectedCohortSize: 3 });
    const short = engine.run(cohort(2), { expectedCohortSize: 3 });
    const solo = engine.run(cohort(1), { expectedCohortSize: 3 });

    expect(full.consensusScore).toBeGreaterThan(short.consensusScore);
    expect(short.consensusScore).toBeGreaterThan(solo.consensusScore);
    // Two agents is thin but real corroboration, not near-zero.
    expect(short.consensusScore).toBeGreaterThan(0.5 * full.consensusScore);
  });

  it("does not penalise a cohort that met its target", () => {
    const outcome = engine.run(cohort(3), { expectedCohortSize: 3 });
    expect(outcome.corroboration.factor).toBe(1);
    expect(outcome.corroboration.short).toBe(false);
  });

  it("does not reward exceeding the target beyond full credit", () => {
    const outcome = engine.run(cohort(5), { expectedCohortSize: 3 });
    expect(outcome.corroboration.factor).toBe(1);
    expect(outcome.consensusScore).toBeLessThanOrEqual(1);
  });

  it("discounts a large job that only partly filled", () => {
    const outcome = engine.run(cohort(3), { expectedCohortSize: 7 });
    expect(outcome.corroboration.factor).toBeLessThan(1);
    expect(outcome.corroboration.factor).toBeGreaterThan(0.5);
    expect(outcome.corroboration.short).toBe(true);
  });

  it("carries the discount through to confidence", () => {
    const full = engine.run(cohort(3), { expectedCohortSize: 3 });
    const solo = engine.run(cohort(1), { expectedCohortSize: 3 });
    // Same stated confidence per agent; the lone result must read lower.
    expect(solo.confidence).toBeLessThan(full.confidence);
  });

  it("defaults to the observed size when the caller states no target", () => {
    const outcome = engine.run(cohort(3));
    expect(outcome.corroboration.expected).toBe(3);
    expect(outcome.corroboration.short).toBe(false);
  });

  it("keeps the raw agreement visible for auditing", () => {
    const outcome = engine.run(cohort(1), { expectedCohortSize: 3 });
    expect(outcome.strategyConfig["rawAgreement"]).toBeGreaterThan(0);
    expect(outcome.strategyConfig["corroborationFactor"]).toBe(0);
  });
});

describe("recommendation under weak corroboration", () => {
  const engine = new ConsensusEngine();
  const withRec = (id: string): ConsensusInput => ({
    ...agent(id, [["Depth is sufficient for execution", 0.9]]),
    recommendation: { action: "Treat as decision-grade", rationale: "because", confidence: 0.9 },
  });

  it("discounts a recommendation nobody corroborated", () => {
    const solo = engine.run([withRec("a")], { expectedCohortSize: 4 });
    const full = engine.run(
      [withRec("a"), withRec("b"), withRec("c"), withRec("d")],
      { expectedCohortSize: 4 },
    );

    expect(solo.recommendation).not.toBeNull();
    // A lone agent must not present a confident recommendation while the rest
    // of the result says nothing was corroborated.
    expect(solo.recommendation!.confidence).toBeLessThan(0.5);
    expect(solo.recommendation!.confidence).toBeLessThan(full.recommendation!.confidence);
  });

  it("leaves a fully corroborated recommendation largely intact", () => {
    const full = engine.run(
      [withRec("a"), withRec("b"), withRec("c")],
      { expectedCohortSize: 3 },
    );
    expect(full.recommendation!.confidence).toBeGreaterThan(0.6);
  });
});
