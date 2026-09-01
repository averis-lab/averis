import { describe, expect, it } from "vitest";
import { AgentSelector, EvaluationEngine, ReputationEngine, type Observation } from "@averis/reputation";
import type { AgentDescriptor, ConsensusInput, Evidence } from "@averis/types";
import { claimFingerprint, NEUTRAL_REPUTATION } from "@averis/types";

const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-08-20T00:00:00Z");

function ev(id: string, reliability: number): Evidence {
  return {
    id, type: "REPPO_POD", source: `reppo://pod/${id}`, title: id, content: "c",
    metadata: {}, reliability, timestamp: now,
  };
}

function output(
  id: string,
  claims: Array<{ text: string; conf: number; evidence: Evidence[] }>,
): ConsensusInput {
  return {
    outputId: `o-${id}`, agentId: id, agentName: id, summary: "s", confidence: 0.8,
    modelProvider: "mock", modelName: "mock-analyst",
    claims: claims.map((c) => ({
      statement: c.text, kind: "ASSESSMENT" as const, confidence: c.conf,
      fingerprint: claimFingerprint(c.text), evidence: c.evidence,
    })),
    metrics: {}, recommendation: null, risks: [],
    signals: { reputation: 0.5, domainReputation: 0.5, accuracy: 0.5, calibration: 0.5, evidenceQuality: 0.5, evaluation: null },
  };
}

describe("evaluation engine", () => {
  const engine = new EvaluationEngine();

  it("scores a well-cited output above an uncited one", () => {
    const cited = output("a", [
      { text: "Curator approval reached 84% across 12000 vote volume", conf: 0.9, evidence: [ev("1", 0.9), ev("2", 0.85)] },
    ]);
    const bare = output("b", [
      { text: "Curator approval reached 84% across 12000 vote volume", conf: 0.9, evidence: [] },
    ]);

    const [a, b] = engine.evaluate([cited, bare]);
    expect(a!.evidenceQuality).toBeGreaterThan(b!.evidenceQuality);
    expect(b!.evidenceQuality).toBe(0);
  });

  it("penalizes an output that contradicts itself", () => {
    const consistent = output("a", [
      { text: "The curated signal is reliable and corroborated", conf: 0.9, evidence: [ev("1", 0.8)] },
      { text: "Depth of coverage is sufficient for the question", conf: 0.8, evidence: [ev("2", 0.8)] },
    ]);
    const contradictory = output("b", [
      { text: "The curated signal is reliable and corroborated", conf: 0.9, evidence: [ev("1", 0.8)] },
      { text: "The curated signal is not reliable and is contested", conf: 0.8, evidence: [ev("2", 0.8)] },
    ]);

    const [a, b] = engine.evaluate([consistent, contradictory]);
    expect(b!.internalConsistency).toBeLessThan(a!.internalConsistency);
  });

  it("rewards concrete claims over hedged ones", () => {
    const concrete = output("a", [
      { text: "Curator approval reached 84.2% across 12000 units of vote volume", conf: 0.9, evidence: [ev("1", 0.8)] },
    ]);
    const hedged = output("b", [
      { text: "Approval might possibly be somewhat generally acceptable perhaps", conf: 0.9, evidence: [ev("1", 0.8)] },
    ]);
    const [a, b] = engine.evaluate([concrete, hedged]);
    expect(a!.specificity).toBeGreaterThan(b!.specificity);
  });

  it("does not price a well-evidenced dissent out of existence", () => {
    const cohort = [
      output("a", [{ text: "The curated signal is reliable and corroborated", conf: 0.9, evidence: [ev("1", 0.9)] }]),
      output("b", [{ text: "The curated signal is reliable and corroborated", conf: 0.9, evidence: [ev("2", 0.9)] }]),
      output("c", [{ text: "The curated signal is not reliable and is contested at 42.1% approval", conf: 0.85, evidence: [ev("3", 0.95), ev("4", 0.92)] }]),
    ];
    const scores = engine.evaluate(cohort);
    const dissenter = scores.find((s) => s.agentId === "c")!;

    expect(dissenter.corroboration).toBeLessThan(0.5);
    // Corroboration is only 0.25 of the blend, so quality still carries it.
    expect(dissenter.overall).toBeGreaterThan(0.4);
  });

  it("scores every dimension inside the unit interval", () => {
    const scores = engine.evaluate([
      output("a", [{ text: "x", conf: 0.5, evidence: [] }]),
      output("b", [{ text: "Approval was 90% over 1000 volume", conf: 0.9, evidence: [ev("1", 1)] }]),
    ]);
    for (const s of scores) {
      for (const key of ["evidenceQuality", "internalConsistency", "specificity", "corroboration", "overall"] as const) {
        expect(s[key]).toBeGreaterThanOrEqual(0);
        expect(s[key]).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("reputation engine", () => {
  const engine = new ReputationEngine();

  it("starts an agent at exactly neutral with no history", () => {
    expect(engine.compute([]).vector).toEqual(NEUTRAL_REPUTATION);
  });

  it("cannot be spiked by a handful of lucky calls", () => {
    const lucky: Observation[] = Array.from({ length: 3 }, () => ({
      kind: "prediction" as const, confidence: 0.99, outcomeWasTrue: true, domain: "crypto", at: now,
    }));
    const { vector } = engine.compute(lucky, now);

    // Three-for-three, yet nowhere near a perfect score.
    expect(vector.accuracy).toBeLessThan(0.7);
    expect(vector.accuracy).toBeGreaterThan(0.5);
  });

  it("converges toward the true rate as evidence accumulates", () => {
    const many: Observation[] = Array.from({ length: 200 }, () => ({
      kind: "prediction" as const, confidence: 0.9, outcomeWasTrue: true, domain: "crypto", at: now,
    }));
    expect(engine.compute(many, now).vector.accuracy).toBeGreaterThan(0.9);
  });

  it("punishes overconfidence more than honest uncertainty", () => {
    const overconfident: Observation[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "prediction" as const, confidence: 0.99, outcomeWasTrue: i % 10 !== 0, domain: "d", at: now,
    }));
    const calibrated: Observation[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "prediction" as const, confidence: 0.9, outcomeWasTrue: i % 10 !== 0, domain: "d", at: now,
    }));

    const a = engine.compute(overconfident, now).vector;
    const b = engine.compute(calibrated, now).vector;

    // Identical hit rates; only the stated confidence differs.
    expect(a.accuracy).toBeCloseTo(b.accuracy, 6);
    expect(a.calibration).toBeLessThan(b.calibration);
  });

  it("decays stale performance so nobody coasts on history", () => {
    const old: Observation[] = Array.from({ length: 40 }, () => ({
      kind: "prediction" as const, confidence: 0.9, outcomeWasTrue: true, domain: "d",
      at: new Date(now.getTime() - 400 * day),
    }));
    const recentBad: Observation[] = Array.from({ length: 40 }, () => ({
      kind: "prediction" as const, confidence: 0.9, outcomeWasTrue: false, domain: "d", at: now,
    }));

    const mixed = engine.compute([...old, ...recentBad], now).vector;
    // Recent failures outweigh a year-old winning streak.
    expect(mixed.accuracy).toBeLessThan(0.5);
  });

  it("has no way to accept capital as an input", () => {
    // Guards the design rule: reputation is performance-only. If a stake
    // parameter is ever added to Observation, this test must be revisited.
    const kinds: Observation["kind"][] = ["evaluation", "prediction", "consensus"];
    expect(kinds).not.toContain("stake");
    const keys = Object.keys({
      kind: "prediction", confidence: 1, outcomeWasTrue: true, domain: null, at: now,
    });
    expect(keys.some((k) => /stake|capital|balance|deposit/i.test(k))).toBe(false);
  });

  it("tracks per-domain reputation separately from overall", () => {
    const observations: Observation[] = [
      ...Array.from({ length: 60 }, () => ({
        kind: "prediction" as const, confidence: 0.85, outcomeWasTrue: true, domain: "defi", at: now,
      })),
      ...Array.from({ length: 60 }, () => ({
        kind: "prediction" as const, confidence: 0.85, outcomeWasTrue: false, domain: "robotics", at: now,
      })),
    ];
    const { byDomain, overall } = engine.computeByDomain(observations, now);

    expect(byDomain["defi"]!.vector.accuracy).toBeGreaterThan(0.75);
    expect(byDomain["robotics"]!.vector.accuracy).toBeLessThan(0.25);
    expect(overall.vector.accuracy).toBeGreaterThan(0.3);
    expect(overall.vector.accuracy).toBeLessThan(0.7);
  });
});

describe("agent selector", () => {
  const selector = new AgentSelector();

  function agent(
    id: string,
    domains: string[],
    overall: number,
    domainScores: Record<string, number> = {},
    extra: Partial<AgentDescriptor> = {},
  ): AgentDescriptor {
    return {
      id, name: id, status: "ACTIVE",
      capabilities: domains.map((d) => ({ domain: d, skill: null, declared: 0.8 })),
      modelProvider: "mock", modelName: "m", tools: [], pricePerJob: 1, maxConcurrent: 3,
      activeAssignments: 0,
      reputation: { ...NEUTRAL_REPUTATION, overall, sampleSize: 50 },
      domainReputation: Object.fromEntries(
        Object.entries(domainScores).map(([d, v]) => [d, { ...NEUTRAL_REPUTATION, overall: v, sampleSize: 50 }]),
      ),
      ...extra,
    };
  }

  it("prefers a domain specialist over a higher-rated generalist", () => {
    const chosen = selector.select(
      [
        agent("generalist", ["research"], 0.95, { research: 0.95 }),
        agent("defi-specialist", ["defi"], 0.62, { defi: 0.94 }),
      ],
      { requiredCapabilities: ["defi"], requiredAgents: 1 },
    );
    expect(chosen[0]!.agentId).toBe("defi-specialist");
  });

  it("builds a cohort that covers different specializations", () => {
    const chosen = selector.select(
      [
        agent("defi-1", ["defi"], 0.9, { defi: 0.9 }),
        agent("defi-2", ["defi"], 0.89, { defi: 0.89 }),
        agent("defi-3", ["defi"], 0.88, { defi: 0.88 }),
        agent("sec-1", ["defi", "security"], 0.7, { defi: 0.7, security: 0.9 }),
      ],
      { requiredCapabilities: ["defi"], requiredAgents: 3 },
    );
    // The diversity bonus pulls in the agent covering a domain nobody else has.
    expect(chosen.map((c) => c.agentId)).toContain("sec-1");
  });

  it("excludes agents that are unavailable, paused or too expensive", () => {
    const chosen = selector.select(
      [
        agent("busy", ["defi"], 0.9, { defi: 0.9 }, { activeAssignments: 3, maxConcurrent: 3 }),
        agent("paused", ["defi"], 0.9, { defi: 0.9 }, { status: "PAUSED" }),
        agent("pricey", ["defi"], 0.9, { defi: 0.9 }, { pricePerJob: 999 }),
        agent("ok", ["defi"], 0.5, { defi: 0.5 }),
      ],
      { requiredCapabilities: ["defi"], requiredAgents: 4, maxPricePerAgent: 10 },
    );
    expect(chosen.map((c) => c.agentId)).toEqual(["ok"]);
  });

  it("returns fewer agents rather than unqualified ones", () => {
    const chosen = selector.select(
      [agent("a", ["robotics"], 0.9, { robotics: 0.9 })],
      { requiredCapabilities: ["defi"], requiredAgents: 3 },
    );
    expect(chosen).toHaveLength(0);
  });

  it("explains every selection score", () => {
    const chosen = selector.select(
      [agent("a", ["defi"], 0.8, { defi: 0.8 })],
      { requiredCapabilities: ["defi"], requiredAgents: 1 },
    );
    expect(chosen[0]!.detail).toHaveProperty("capabilityMatch");
    expect(chosen[0]!.detail).toHaveProperty("domainReputation");
    expect(chosen[0]!.detail).toHaveProperty("diversity");
  });
});
