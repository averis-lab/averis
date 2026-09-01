import { describe, expect, it } from "vitest";
import { CreateJobSchema, describeQueryProblem, normalizeQuery } from "@averis/types";

/**
 * The gate exists to stop a cohort, a budget and a settlement being spent on a
 * message that was never a brief. These cases are drawn from what the live
 * jobs list actually accepted under the old `min(8)` rule.
 */
describe("describeQueryProblem", () => {
  it("rejects the junk the old rule let through", () => {
    for (const junk of ["are u retrarded", "Am i gay ?", "hi there", "test lol", "wen moon"]) {
      expect(describeQueryProblem(junk), junk).not.toBeNull();
    }
  });

  it("rejects placeholder and mashed input", () => {
    for (const junk of [
      "test test test test test",
      "asdf asdf asdf asdf asdf",
      "lorem ipsum dolor sit amet",
      "1234567890 12345 1234 123 12 1",
      "?????? !!!!!! ------ ...... ;;;;;;",
      "",
      "   ",
    ]) {
      expect(describeQueryProblem(junk), JSON.stringify(junk)).not.toBeNull();
    }
  });

  it("accepts real briefs, including the ones the UI ships as presets", () => {
    for (const brief of [
      "Assess whether the curated geopolitical and market intelligence in these Datanets is reliable enough for an autonomous trading agent to act on.",
      "Analyse the quality and credibility of tokenomics and real-world-asset signals in the curated corpus for an autonomous allocator.",
      "Identify integrity risks, low-conviction items and possible manipulation in the curated corpus.",
      // Mostly-hex, but framed as a question about the address.
      "Assess whether 0xfe54eb048d38d3f2af223139d5e8ee5a275cc292 is worth buying",
      // Conversational phrasing is still a brief; this gate is not a style guide.
      "Do you think AVRS has enough liquidity to trade against right now",
    ]) {
      expect(describeQueryProblem(brief), brief).toBeNull();
    }
  });

  it("does not reject a brief merely for containing a placeholder word", () => {
    expect(
      describeQueryProblem("Evaluate the sample methodology behind these curation votes"),
    ).toBeNull();
  });

  it("refuses a brief longer than the cap", () => {
    expect(describeQueryProblem(`Assess ${"the corpus ".repeat(400)}`)).not.toBeNull();
  });
});

describe("normalizeQuery", () => {
  it("collapses whitespace so the duplicate guard cannot be defeated by a stray space", () => {
    expect(normalizeQuery("  Assess   whether the\n corpus is reliable  ")).toBe(
      "Assess whether the corpus is reliable",
    );
  });
});

describe("CreateJobSchema", () => {
  const base = { type: "dataset-evaluation" };

  it("refuses a junk query with the reason attached", () => {
    const result = CreateJobSchema.safeParse({ ...base, query: "are u retrarded" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least/i);
    }
  });

  it("stores the normalized brief, not the raw one", () => {
    const result = CreateJobSchema.safeParse({
      ...base,
      query: "  Assess   whether the curated corpus is reliable enough to act on  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.query).toBe(
        "Assess whether the curated corpus is reliable enough to act on",
      );
    }
  });
});
