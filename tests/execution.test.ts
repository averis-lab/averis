import { describe, expect, it } from "vitest";
// Imported by path rather than through the barrel, which also re-exports the
// engine and would pull in a database connection — the same reason
// settlement.test.ts reaches straight for settlement-plan.
import {
  deriveBreaker,
  planEntry,
  planExit,
  type ClosedTrade,
  type EntryInput,
  type IntelligenceVerdict,
  type OpenPosition,
} from "../packages/execution/src/plan";
import {
  DEFAULT_TRADE_POLICY,
  TradePolicySchema,
} from "../packages/execution/src/policy";
import {
  NoneDriver,
  PaperDriver,
  resolveDriver,
} from "../packages/execution/src/drivers";

const NOW = new Date("2026-08-25T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const policy = TradePolicySchema.parse({
  minConfidence: 0.65,
  minConsensus: 0.6,
  minAgents: 3,
  sizeUsd: 25,
  maxConcurrentPositions: 3,
  maxDeployedUsd: 100,
  takeProfitPct: 60,
  stopLossPct: 25,
  trailingActivationPct: 40,
  trailingStopPct: 20,
  maxHoldMinutes: 240,
  maxConsecutiveLosses: 3,
  maxDailyDrawdownUsd: 50,
  cooldownAfterLossMinutes: 30,
  tokenCooldownMinutes: 60,
});

const verdict = (overrides: Partial<IntelligenceVerdict> = {}): IntelligenceVerdict => ({
  jobId: "job-1",
  token: "TokenAAA",
  symbol: "AAA",
  action: "buy",
  confidence: 0.8,
  consensus: 0.75,
  agentsReporting: 3,
  unsupportedClaims: 0,
  disagreements: 0,
  ...overrides,
});

const entry = (overrides: Partial<EntryInput> = {}): EntryInput => ({
  verdict: verdict(),
  policy,
  active: true,
  openPositions: [],
  recentTrades: [],
  breakerResetAt: null,
  now: NOW,
  ...overrides,
});

const position = (overrides: Partial<OpenPosition> = {}): OpenPosition => ({
  id: "pos-1",
  token: "TokenAAA",
  sizeUsd: 25,
  entryPrice: 100,
  peakPrice: 100,
  openedAt: minutesAgo(10),
  ...overrides,
});

describe("entry gate", () => {
  it("opens at the policy size when every gate passes", () => {
    const decision = planEntry(entry());
    expect(decision.open).toBe(true);
    expect(decision.reason).toBeNull();
    expect(decision.sizeUsd).toBe(25);
    expect(decision.gates.every((g) => g.passed)).toBe(true);
  });

  it("evaluates every gate even after one has failed", () => {
    const decision = planEntry(
      entry({ active: false, verdict: verdict({ confidence: 0.1, agentsReporting: 1 }) }),
    );
    expect(decision.open).toBe(false);
    // The operator asking "why did nothing trade" needs all three answers,
    // not just the first one that happened to fail.
    const failed = decision.gates.filter((g) => !g.passed).map((g) => g.gate);
    expect(failed).toContain("STOPPED");
    expect(failed).toContain("LOW_CONFIDENCE");
    expect(failed).toContain("THIN_COHORT");
  });

  it("refuses a confidently split cohort", () => {
    // The whole reason confidence and consensus are separate floors: this
    // verdict is highly confident and barely corroborated.
    const decision = planEntry(entry({ verdict: verdict({ confidence: 0.95, consensus: 0.2 }) }));
    expect(decision.open).toBe(false);
    expect(decision.reason).toBe("LOW_CONSENSUS");
  });

  it("refuses a claim citing evidence that was never retrieved", () => {
    const decision = planEntry(entry({ verdict: verdict({ unsupportedClaims: 1 }) }));
    expect(decision.reason).toBe("UNSUPPORTED_CLAIMS");
  });

  it("refuses anything that is not a buy", () => {
    for (const action of ["hold", "sell", "avoid", ""]) {
      expect(planEntry(entry({ verdict: verdict({ action }) })).reason).toBe("NOT_A_BUY");
    }
    for (const action of ["buy", "BUY", " Long ", "accumulate"]) {
      expect(planEntry(entry({ verdict: verdict({ action }) })).open).toBe(true);
    }
  });

  it("refuses a second position in a token it already holds", () => {
    const decision = planEntry(entry({ openPositions: [position()] }));
    expect(decision.reason).toBe("ALREADY_HOLDING");
  });

  it("holds the per-token cooldown after a trade in the same name", () => {
    const trades: ClosedTrade[] = [{ token: "TokenAAA", pnlUsd: 12, closedAt: minutesAgo(30) }];
    expect(planEntry(entry({ recentTrades: trades })).reason).toBe("TOKEN_COOLDOWN");
    // Same trade, past the window.
    const old: ClosedTrade[] = [{ token: "TokenAAA", pnlUsd: 12, closedAt: minutesAgo(61) }];
    expect(planEntry(entry({ recentTrades: old })).open).toBe(true);
  });

  it("counts the position it is about to open against the deployed ceiling", () => {
    // Three open at $25 is $75; the fourth would be $100, which is the ceiling
    // exactly and therefore allowed — but the position limit binds first.
    const open = [
      position({ id: "a", token: "M1" }),
      position({ id: "b", token: "M2" }),
      position({ id: "c", token: "M3" }),
    ];
    expect(planEntry(entry({ openPositions: open })).reason).toBe("MAX_POSITIONS");

    const roomy = TradePolicySchema.parse({ ...policy, maxConcurrentPositions: 10 });
    expect(planEntry(entry({ openPositions: open, policy: roomy })).open).toBe(true);

    const fourth = [...open, position({ id: "d", token: "M4" })];
    expect(planEntry(entry({ openPositions: fourth, policy: roomy })).reason).toBe("MAX_DEPLOYED");
  });
});

describe("circuit breaker", () => {
  const loss = (n: number): ClosedTrade => ({
    token: `M${n}`,
    pnlUsd: -5,
    closedAt: minutesAgo(n),
  });

  it("trips on consecutive losses and blocks entry", () => {
    const trades = [loss(1), loss(2), loss(3)];
    const state = deriveBreaker(trades, policy, null, NOW);
    expect(state.paused).toBe(true);
    expect(state.consecutiveLosses).toBe(3);
    expect(planEntry(entry({ recentTrades: trades })).reason).toBe("BREAKER_TRIPPED");
  });

  it("counts consecutively from the most recent trade, not in total", () => {
    // Two losses, a win, then a loss: the streak is one, not three.
    const trades = [loss(1), { token: "MW", pnlUsd: 20, closedAt: minutesAgo(2) }, loss(3), loss(4)];
    expect(deriveBreaker(trades, policy, null, NOW).consecutiveLosses).toBe(1);
  });

  it("trips on daily drawdown independently of the streak", () => {
    const trades: ClosedTrade[] = [{ token: "M1", pnlUsd: -60, closedAt: minutesAgo(5) }];
    const state = deriveBreaker(trades, policy, null, NOW);
    expect(state.paused).toBe(true);
    expect(state.reason).toContain("drawdown");
    expect(state.consecutiveLosses).toBe(1);
  });

  it("is cleared by a reset without deleting the trades that caused it", () => {
    const trades = [loss(10), loss(20), loss(30)];
    expect(deriveBreaker(trades, policy, null, NOW).paused).toBe(true);
    // Reset after the last loss: the same history, a moved window.
    const state = deriveBreaker(trades, policy, minutesAgo(5), NOW);
    expect(state.paused).toBe(false);
    expect(state.consecutiveLosses).toBe(0);
  });

  it("ignores losses older than the daily window for drawdown", () => {
    const trades: ClosedTrade[] = [
      { token: "M1", pnlUsd: -60, closedAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000) },
    ];
    expect(deriveBreaker(trades, policy, null, NOW).paused).toBe(false);
  });
});

describe("exit rules", () => {
  it("takes profit at the target", () => {
    const exit = planExit(position(), 160, policy, NOW);
    expect(exit.close).toBe(true);
    expect(exit.reason).toBe("TAKE_PROFIT");
  });

  it("stops out at the loss limit", () => {
    const exit = planExit(position(), 75, policy, NOW);
    expect(exit.reason).toBe("STOP_LOSS");
  });

  it("prefers the stop when a move trips both", () => {
    // A position already up 80% that prints 70 in the same check is a loss.
    // Booking the take profit would make every backtest of this policy
    // optimistic in exactly the cases that matter.
    const exit = planExit(position({ peakPrice: 180 }), 70, policy, NOW);
    expect(exit.reason).toBe("STOP_LOSS");
  });

  it("arms the trailing stop only after the activation gain", () => {
    // Peak +30% is below the +40% activation, so a 25% giveback is not an exit.
    expect(planExit(position({ peakPrice: 130 }), 98, policy, NOW).close).toBe(false);
    // Peak +50%, now 20% off that peak.
    const armed = planExit(position({ peakPrice: 150 }), 120, policy, NOW);
    expect(armed.reason).toBe("TRAILING_STOP");
  });

  it("carries the peak forward on every mark", () => {
    const exit = planExit(position({ peakPrice: 100 }), 130, policy, NOW);
    expect(exit.close).toBe(false);
    expect(exit.peakPrice).toBe(130);
  });

  it("closes on the hold limit", () => {
    const exit = planExit(position({ openedAt: minutesAgo(241) }), 105, policy, NOW);
    expect(exit.reason).toBe("MAX_HOLD");
  });
});

describe("drivers", () => {
  it("defaults to a driver that refuses rather than a no-op that lies", async () => {
    const driver = resolveDriver(undefined);
    expect(driver.name).toBe("none");
    await expect(driver.open({ token: "M", symbol: "S", sizeUsd: 1, price: 1 })).rejects.toThrow(
      /No execution driver/,
    );
    expect(new NoneDriver().spendsRealMoney).toBe(false);
  });

  it("refuses an unknown driver name instead of falling back", () => {
    // A typo in the variable that decides whether money moves must fail loudly,
    // not resolve to `none` and surface the day it is corrected.
    expect(() => resolveDriver("liv")).toThrow(/Unknown EXECUTION_DRIVER/);
  });

  it("has no live driver at all", () => {
    expect(() => resolveDriver("live")).toThrow(/no live driver/);
  });

  it("books paper fills at the quoted price and rejects a bad mark", async () => {
    const paper = new PaperDriver();
    expect(paper.spendsRealMoney).toBe(false);
    await expect(paper.open({ token: "M", symbol: "S", sizeUsd: 25, price: 1.5 })).resolves.toEqual({
      price: 1.5,
      signature: null,
    });
    await expect(paper.open({ token: "M", symbol: "S", sizeUsd: 25, price: 0 })).rejects.toThrow();
  });
});

describe("policy defaults", () => {
  it("starts from limits that are conservative rather than absent", () => {
    expect(DEFAULT_TRADE_POLICY.maxConcurrentPositions).toBeGreaterThan(0);
    expect(DEFAULT_TRADE_POLICY.stopLossPct).toBeGreaterThan(0);
    expect(DEFAULT_TRADE_POLICY.maxHoldMinutes).toBeGreaterThan(0);
    expect(DEFAULT_TRADE_POLICY.maxUnsupportedClaims).toBe(0);
  });

  it("rejects a policy with no stop rather than defaulting it away", () => {
    expect(() => TradePolicySchema.parse({ stopLossPct: 0 })).toThrow();
    expect(() => TradePolicySchema.parse({ sizeUsd: -1 })).toThrow();
  });
});
