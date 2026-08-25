import { describe, expect, it } from "vitest";
import {
  BudgetGuard,
  BudgetExceededError,
  BudgetPolicySchema,
  MemorySpendLedger,
  type SpendRequest,
} from "@averis/budget";

const policy = BudgetPolicySchema.parse({
  daily: 20, weekly: 100, perJob: 5, perAgent: 2, transactionReserve: 5,
});

function guard() {
  const ledger = new MemorySpendLedger();
  return { ledger, guard: new BudgetGuard(ledger, policy) };
}

const req = (overrides: Partial<SpendRequest> = {}): SpendRequest => ({
  operatorId: "op-1", jobId: "job-1", agentId: "agent-1",
  category: "llm", estimatedUsd: 1, ...overrides,
});

describe("budget guard", () => {
  it("allows spend that fits every limit", async () => {
    const { guard: g } = guard();
    const decision = await g.check(req({ estimatedUsd: 1 }));
    expect(decision.allowed).toBe(true);
    expect(decision.checks.length).toBeGreaterThan(0);
  });

  it("commits the estimate to the ledger at reservation time, not after", async () => {
    const { ledger, guard: g } = guard();
    await g.reserve(req({ estimatedUsd: 1.5 }));
    // Nothing has executed yet, but the money is already accounted for.
    const committed = await ledger.committed({ operatorId: "op-1", since: new Date(0) });
    expect(committed).toBe(1.5);
  });

  it("blocks a second reservation that would breach the per-agent limit", async () => {
    const { guard: g } = guard();
    await g.reserve(req({ estimatedUsd: 1.5 }));
    await expect(g.reserve(req({ estimatedUsd: 1 }))).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("blocks concurrent bursts, because reservations are counted immediately", async () => {
    const { guard: g } = guard();
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        g.reserve(req({ agentId: `agent-${i}`, estimatedUsd: 1 })),
      ),
    );
    const granted = attempts.filter((a) => a.status === "fulfilled").length;
    // perJob is 5, so at most five 1-dollar runs can be admitted.
    expect(granted).toBeLessThanOrEqual(5);
    expect(granted).toBeGreaterThan(0);
  });

  it("refuses to let inference eat the settlement reserve", async () => {
    const { guard: g } = guard();
    // daily 20 with a 5 reserve leaves 15 for inference.
    for (let i = 0; i < 3; i++) {
      await g.reserve(req({ jobId: `job-${i}`, agentId: `a-${i}`, estimatedUsd: 2 }));
    }
    const decision = await g.check(req({ jobId: "job-x", agentId: "a-x", estimatedUsd: 12 }));
    expect(decision.allowed).toBe(false);

    // A settlement request may use the full daily budget, including the reserve.
    const settlement = await g.check(
      req({ jobId: null, agentId: null, category: "settlement", estimatedUsd: 12 }),
    );
    expect(settlement.allowed).toBe(true);
  });

  it("rejects a nonsensical estimate instead of treating it as free", async () => {
    const { guard: g } = guard();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      const decision = await g.check(req({ estimatedUsd: bad }));
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("INVALID_ESTIMATE");
    }
  });

  it("reconciles the real cost after the work runs", async () => {
    const { ledger, guard: g } = guard();
    const result = await g.withBudget(req({ estimatedUsd: 2 }), async () => ({
      result: "done",
      actualUsd: 0.4,
    }));

    expect(result).toBe("done");
    expect(await ledger.committed({ operatorId: "op-1", since: new Date(0) })).toBe(0.4);
  });

  it("keeps the committed estimate when the work throws", async () => {
    const { ledger, guard: g } = guard();
    await expect(
      g.withBudget(req({ estimatedUsd: 2 }), async () => {
        throw new Error("agent crashed");
      }),
    ).rejects.toThrow("agent crashed");

    // A crash-looping agent must not be able to spend for free.
    expect(await ledger.committed({ operatorId: "op-1", since: new Date(0) })).toBe(2);
  });

  it("never runs the work when the budget denies it", async () => {
    const { guard: g } = guard();
    let ran = false;
    await expect(
      g.withBudget(req({ estimatedUsd: 999 }), async () => {
        ran = true;
        return { result: null, actualUsd: 999 };
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(ran).toBe(false);
  });

  it("releases a reservation whose work never started", async () => {
    const { ledger, guard: g } = guard();
    const reservation = await g.reserve(req({ estimatedUsd: 2 }));
    await reservation.release();
    expect(await ledger.committed({ operatorId: "op-1", since: new Date(0) })).toBe(0);
  });

  it("enforces the rolling daily window", async () => {
    const { ledger, guard: g } = guard();
    const now = new Date("2026-08-20T12:00:00Z");
    for (let i = 0; i < 7; i++) {
      await ledger.reserve({
        operatorId: "op-1", jobId: `j-${i}`, agentId: null, category: "llm", reserved: 2,
      });
    }
    // 14 committed against a 15 inference ceiling.
    expect((await g.check(req({ jobId: "new", agentId: "new", estimatedUsd: 0.5 }), now)).allowed).toBe(true);
    expect((await g.check(req({ jobId: "new", agentId: "new", estimatedUsd: 2 }), now)).allowed).toBe(false);
  });

  it("explains which limit blocked the spend", async () => {
    const { guard: g } = guard();
    const decision = await g.check(req({ estimatedUsd: 3 }));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("PER_AGENT_LIMIT");
    expect(decision.message).toMatch(/PER_AGENT_LIMIT/);
  });
});
