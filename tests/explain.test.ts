import { describe, expect, it } from "vitest";
import {
  EXPLAIN_THRESHOLDS,
  explainClaim,
  explainJob,
  verdictFor,
  type ExplainableClaim,
  type ExplainableJob,
  type ExplainedEvidence,
  claimFromStored,
  evidenceFromStored,
} from "../packages/protocol/src/explain";

/**
 * The explanation is the feature that distinguishes this from a wrapper, so
 * its rules are tested rather than eyeballed: a verdict that quietly said
 * SUPPORTED for a claim nothing evidenced would be worse than no verdict.
 */

const evidence = (over: Partial<ExplainedEvidence> = {}): ExplainedEvidence => ({
  source: "reppo://pod/abc",
  title: "A curated pod",
  reliability: 0.82,
  stance: "supports",
  curation: { upVotes: 36, downVotes: 21, approvalRate: 0.63, epoch: 140 },
  ...over,
});

const claim = (over: Partial<ExplainableClaim> = {}): ExplainableClaim => ({
  statement: "62% of accepted pods cluster into three of eleven topics",
  kind: "ASSESSMENT",
  confidence: 0.74,
  support: 1,
  supportedBy: ["agent_1", "agent_2", "agent_3"],
  contradictedBy: [],
  evidence: [evidence()],
  ...over,
});

describe("verdicts", () => {
  it("supports a corroborated, well-evidenced claim", () => {
    expect(verdictFor(claim(), 0.82)).toBe("SUPPORTED");
  });

  it("calls a claim with no supporting evidence UNSUPPORTED, however popular", () => {
    const popular = claim({ evidence: [], supportedBy: ["a", "b", "c", "d"] });
    // A claim nobody could evidence does not become true by being asserted.
    expect(verdictFor(popular, 0)).toBe("UNSUPPORTED");
  });

  it("calls a contradicted claim DISPUTED even when it is otherwise strong", () => {
    expect(verdictFor(claim({ contradictedBy: ["agent_4"] }), 0.9)).toBe("DISPUTED");
    expect(
      verdictFor(claim({ evidence: [evidence(), evidence({ stance: "contradicts" })] }), 0.9),
    ).toBe("DISPUTED");
  });

  it("calls a lone agent's claim THIN", () => {
    expect(verdictFor(claim({ supportedBy: ["agent_1"] }), 0.9)).toBe("THIN");
  });

  it("calls a claim resting on unvetted sources THIN", () => {
    const weak = EXPLAIN_THRESHOLDS.THIN_EVIDENCE - 0.01;
    expect(verdictFor(claim({ evidence: [evidence({ reliability: weak })] }), weak)).toBe("THIN");
  });

  it("puts contradiction ahead of thinness", () => {
    const both = claim({ supportedBy: ["agent_1"], contradictedBy: ["agent_2"] });
    expect(verdictFor(both, 0.1)).toBe("DISPUTED");
  });
});

describe("the chain behind a claim", () => {
  it("quotes the upstream vote volumes that gave a source its weight", () => {
    const explained = explainClaim(claim(), 3);
    const chain = explained.reasons.join(" ");

    expect(chain).toContain("3 of 3 agents");
    expect(chain).toContain("mean upstream reliability 0.82");
    // The point where the trail leaves the model and lands on the curation market.
    expect(chain).toContain("36 up-vote volume");
    expect(chain).toContain("21 down");
    expect(chain).toContain("63% approval");
    expect(chain).toContain("epoch 140");
    expect(chain).toContain("No agent contradicted it");
  });

  it("falls back to the reliability when a source carries no curation", () => {
    const explained = explainClaim(claim({ evidence: [evidence({ curation: null })] }), 3);
    expect(explained.reasons.join(" ")).toContain("reliability 0.82");
  });

  it("says plainly when nothing supports a claim", () => {
    const explained = explainClaim(claim({ evidence: [] }), 3);
    expect(explained.verdict).toBe("UNSUPPORTED");
    expect(explained.reasons.join(" ")).toContain("No retrieved evidence supports it");
  });

  it("averages only the supporting evidence", () => {
    const explained = explainClaim(
      claim({
        evidence: [
          evidence({ reliability: 1 }),
          evidence({ reliability: 0.5 }),
          evidence({ reliability: 0, stance: "contradicts" }),
        ],
      }),
      3,
    );
    expect(explained.evidenceQuality).toBeCloseTo(0.75);
  });
});

describe("the job-level explanation", () => {
  const job = (over: Partial<ExplainableJob> = {}): ExplainableJob => ({
    confidence: 0.78,
    consensusScore: 0.84,
    minimumConfidence: null,
    corroboration: { cohortSize: 3, expected: 3, factor: 1, short: false },
    claims: [claim(), claim({ statement: "second" })],
    disagreements: [],
    evaluations: [
      { agentName: "Markets Agent", overall: 0.8 },
      { agentName: "Research Agent", overall: 0.7 },
    ],
    ...over,
  });

  it("reports the three reliabilities separately", () => {
    const explanation = explainJob(job());

    expect(explanation.reliability.evidence).toBeCloseTo(0.82);
    expect(explanation.reliability.reasoning).toBeCloseTo(0.75);
    // Outcome stays null until a prediction has actually resolved. A placeholder
    // here would be the one lie this design exists to prevent.
    expect(explanation.reliability.outcome).toBeNull();
  });

  it("keeps confidence and consensus as two numbers", () => {
    const explanation = explainJob(job());
    expect(explanation.confidence).toBe(0.78);
    expect(explanation.consensusScore).toBe(0.84);
    expect(explanation.reasons.join(" ")).toContain("separately");
  });

  it("warns when the cohort came up short, quoting the discount", () => {
    const explanation = explainJob(
      job({ corroboration: { cohortSize: 1, expected: 4, factor: 0, short: true } }),
    );

    expect(explanation.caveats.join(" ")).toContain("Only 1 of 4 agents finished");
    // One agent corroborates nothing, so the result cannot read as SUPPORTED.
    expect(explanation.verdict).toBe("THIN");
  });

  it("surfaces open disagreements and unsupported claims as caveats", () => {
    const explanation = explainJob(
      job({
        claims: [claim(), claim({ statement: "unevidenced", evidence: [] })],
        disagreements: [{ statement: "is the corpus tradeable?" }],
      }),
    );

    const caveats = explanation.caveats.join(" ");
    expect(caveats).toContain("1 topic(s) were left as open disagreements");
    expect(caveats).toContain("1 claim(s) cited no retrieved evidence");
  });

  it("flags a result that fell below the floor the job asked for", () => {
    const explanation = explainJob(job({ confidence: 0.3, minimumConfidence: 0.5 }));
    expect(explanation.caveats.join(" ")).toContain("below the 50% floor");
  });

  it("reads DISPUTED when disputed claims outnumber supported ones", () => {
    const explanation = explainJob(job({ claims: [claim({ contradictedBy: ["x"] })] }));
    expect(explanation.verdict).toBe("DISPUTED");
  });

  it("reads UNSUPPORTED when there is nothing to rely on", () => {
    expect(explainJob(job({ claims: [] })).verdict).toBe("UNSUPPORTED");
    expect(explainJob(job({ claims: [claim({ evidence: [] })] })).verdict).toBe("UNSUPPORTED");
  });
});

describe("reading what the merge stored", () => {
  it("recovers the Reppo vote volumes from evidence metadata", () => {
    const lifted = evidenceFromStored(
      {
        source: "reppo://pod/abc",
        title: "A pod",
        reliability: 0.82,
        metadata: { upVotes: 36, downVotes: 21, approvalRate: 0.63, epoch: 140, author: "x" },
      },
      "supports",
    );

    expect(lifted.curation).toEqual({
      upVotes: 36,
      downVotes: 21,
      approvalRate: 0.63,
      epoch: 140,
    });
  });

  it("reports no curation for evidence that never had any", () => {
    // An HTTP fetch carries no vote volumes; a neutral pair would imply a
    // curation that never happened.
    const web = evidenceFromStored(
      { source: "https://example.test/page", reliability: 0.35, metadata: { host: "example.test" } },
      "supports",
    );

    expect(web.curation).toBeNull();
    expect(web.reliability).toBe(0.35);
  });

  it("survives a stored row missing every optional field", () => {
    const bare = evidenceFromStored({ source: "reppo://pod/x" }, "contradicts");

    expect(bare).toMatchObject({ title: null, reliability: 0.5, stance: "contradicts" });
    expect(bare.curation).toBeNull();
  });

  it("splits stored supporting and contradicting evidence by stance", () => {
    const claim = claimFromStored({
      statement: "a claim",
      kind: "ASSESSMENT",
      confidence: 0.7,
      supportedBy: ["a", "b"],
      supportingEvidence: [{ source: "reppo://pod/1", reliability: 0.9 }],
      contradictingEvidence: [{ source: "reppo://pod/2", reliability: 0.4 }],
    });

    expect(claim.evidence.map((e) => e.stance)).toEqual(["supports", "contradicts"]);
    expect(claim.contradictedBy).toEqual([]);
  });
});
