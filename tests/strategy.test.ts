import { describe, expect, it } from "vitest";
import { StrategyEngine, StrategyConfigSchema, parseCadence, type CandidateJob } from "@averis/strategy";

const now = new Date("2026-08-20T12:00:00Z");
const hour = 60 * 60 * 1000;

const job = (overrides: Partial<CandidateJob> = {}): CandidateJob => ({
  id: "j1",
  type: "asset-analysis",
  requiredCapabilities: ["defi"],
  budget: 5,
  minimumConfidence: 0.6,
  deadline: new Date(now.getTime() + hour),
  status: "QUEUED",
  ...overrides,
});

const engine = (overrides = {}) =>
  new StrategyEngine(
    StrategyConfigSchema.parse({
      domains: ["defi", "crypto"],
      minReward: 1,
      maxRequiredConfidence: 0.9,
      maxConcurrentJobs: 2,
      cadence: "30m",
      ...overrides,
    }),
  );

describe("cadence parsing", () => {
  it("parses the documented forms", () => {
    expect(parseCadence("45s")).toBe(45_000);
    expect(parseCadence("30m")).toBe(1_800_000);
    expect(parseCadence("2h")).toBe(7_200_000);
    expect(parseCadence("1d")).toBe(86_400_000);
  });

  it("rejects a malformed cadence rather than defaulting", () => {
    // Silently defaulting would make an unattended node poll at a rate its
    // operator never chose.
    expect(() => parseCadence("soon")).toThrow(/Invalid cadence/);
    expect(() => parseCadence("30")).toThrow(/Invalid cadence/);
  });
});

describe("strategy engine", () => {
  it("accepts work inside its mandate", () => {
    expect(engine().evaluate(job(), now).accept).toBe(true);
  });

  it("skips work outside its domains", () => {
    const decision = engine().evaluate(job({ requiredCapabilities: ["robotics"] }), now);
    expect(decision.accept).toBe(false);
    expect(decision.reason).toBe("DOMAIN_MISMATCH");
  });

  it("skips underpaid work", () => {
    expect(engine().evaluate(job({ budget: 0.1 }), now).reason).toBe("REWARD_TOO_LOW");
  });

  it("skips a job it could not satisfy anyway", () => {
    // Taking a job whose confidence bar is out of reach burns budget for a
    // result the protocol will reject.
    expect(engine().evaluate(job({ minimumConfidence: 0.99 }), now).reason).toBe(
      "CONFIDENCE_TOO_HIGH",
    );
  });

  it("skips a job that cannot finish before its deadline", () => {
    const decision = engine().evaluate(
      job({ deadline: new Date(now.getTime() + 5_000) }),
      now,
    );
    expect(decision.reason).toBe("DEADLINE_TOO_CLOSE");
  });

  it("never exceeds the concurrency ceiling", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => job({ id: `j${i}` }));
    const decisions = engine().select(candidates, 0, now);

    expect(decisions.filter((d) => d.accept)).toHaveLength(2);
    expect(decisions.filter((d) => d.reason === "AT_CAPACITY")).toHaveLength(4);
  });

  it("accounts for work already in flight", () => {
    const candidates = Array.from({ length: 4 }, (_, i) => job({ id: `j${i}` }));
    expect(engine().select(candidates, 2, now).filter((d) => d.accept)).toHaveLength(0);
  });

  it("prefers better-paid work when capacity is scarce", () => {
    const decisions = engine({ maxConcurrentJobs: 1 }).select(
      [job({ id: "cheap", budget: 2 }), job({ id: "rich", budget: 20 })],
      0,
      now,
    );
    expect(decisions.find((d) => d.accept)?.jobId).toBe("rich");
  });

  it("accepts any domain when none are configured", () => {
    const open = new StrategyEngine(StrategyConfigSchema.parse({ domains: [] }));
    expect(open.evaluate(job({ requiredCapabilities: ["robotics"] }), now).accept).toBe(true);
  });
});
