import { describe, expect, it } from "vitest";
import {
  DUST,
  LedgerSettlementDriver,
  NoSettlementDriver,
  addressBookFrom,
  createSettlementDriver,
  planSettlement,
  type PlannableReward,
  type SettlementDriver,
} from "../packages/protocol/src/settlement-plan";

/**
 * Settlement is the one irreversible step in the protocol, so the rules that
 * decide whether a payment happens are kept pure and tested here without a
 * database, a chain, or money.
 */

const reward = (over: Partial<PlannableReward> = {}): PlannableReward => ({
  id: "rw_1",
  jobId: "job_1",
  role: "AGENT",
  status: "PENDING",
  amount: 1.5,
  currency: "USDC",
  agentId: "agent_1",
  agentPayee: "9xQeWvG816bUx9EPa2mNSMh1p4hbGRQ7pd5yPeeeeeee",
  ...over,
});

const reasonFor = (plan: ReturnType<typeof planSettlement>, id: string) =>
  plan.skips.find((skip) => skip.rewardId === id)?.reason ?? "";

describe("planSettlement", () => {
  it("pays an agent at the wallet its owner registered", () => {
    const plan = planSettlement([reward()]);

    expect(plan.instructions).toHaveLength(1);
    expect(plan.instructions[0]).toMatchObject({
      rewardId: "rw_1",
      payee: "9xQeWvG816bUx9EPa2mNSMh1p4hbGRQ7pd5yPeeeeeee",
      amount: 1.5,
    });
  });

  it("skips an agent with no payout address rather than guessing one", () => {
    const plan = planSettlement([reward({ agentPayee: null })]);

    expect(plan.instructions).toEqual([]);
    expect(reasonFor(plan, "rw_1")).toContain("no payout address");
  });

  it("pays the protocol roles from the address book", () => {
    const plan = planSettlement(
      [
        reward({ id: "rw_v", role: "VALIDATOR", agentId: null, agentPayee: null }),
        reward({ id: "rw_p", role: "PROTOCOL", agentId: null, agentPayee: null }),
        reward({ id: "rw_t", role: "TREASURY", agentId: null, agentPayee: null }),
      ],
      { VALIDATOR: "val-addr", PROTOCOL: "proto-addr" },
    );

    expect(plan.instructions.map((i) => i.payee)).toEqual(["val-addr", "proto-addr"]);
    expect(reasonFor(plan, "rw_t")).toContain("no address configured for TREASURY");
  });

  it("refuses anything that is not PENDING", () => {
    for (const status of ["APPROVED", "SETTLED", "FORFEITED"]) {
      const plan = planSettlement([reward({ status })]);
      expect(plan.instructions).toEqual([]);
      expect(reasonFor(plan, "rw_1")).toContain(status);
    }
  });

  it("skips zero and sub-dust amounts", () => {
    expect(reasonFor(planSettlement([reward({ amount: 0 })]), "rw_1")).toContain("zero");
    expect(reasonFor(planSettlement([reward({ amount: -5 })]), "rw_1")).toContain("zero");
    expect(reasonFor(planSettlement([reward({ amount: DUST / 2 })]), "rw_1")).toContain("below");
    // Exactly one unit is representable, so it pays.
    expect(planSettlement([reward({ amount: DUST })]).instructions).toHaveLength(1);
  });
});

describe("the budget guard", () => {
  const split = [
    reward({ id: "a", amount: 2 }),
    reward({ id: "b", amount: 2, agentId: "agent_2" }),
  ];

  it("pays a split that fits inside the job's budget", () => {
    const plan = planSettlement(split, {}, { budgets: { job_1: 4 } });
    expect(plan.instructions).toHaveLength(2);
  });

  it("holds the entire job when the rewards exceed it", () => {
    const plan = planSettlement(split, {}, { budgets: { job_1: 3 } });

    // Not "pay what fits": a split that does not add up is a bug upstream, and
    // paying half of it would be harder to unwind than paying none.
    expect(plan.instructions).toEqual([]);
    expect(reasonFor(plan, "a")).toContain("more than its budget");
    expect(reasonFor(plan, "b")).toContain("more than its budget");
  });

  it("holds only the job that overspent", () => {
    const plan = planSettlement(
      [...split, reward({ id: "c", jobId: "job_2", amount: 1 })],
      {},
      { budgets: { job_1: 3, job_2: 5 } },
    );

    expect(plan.instructions.map((i) => i.rewardId)).toEqual(["c"]);
  });

  it("tolerates float drift in a normalised split", () => {
    const thirds = [
      reward({ id: "a", amount: 1 / 3 }),
      reward({ id: "b", amount: 1 / 3 }),
      reward({ id: "c", amount: 1 / 3 }),
    ];
    expect(planSettlement(thirds, {}, { budgets: { job_1: 1 } }).instructions).toHaveLength(3);
  });

  it("checks nothing when no budget is supplied", () => {
    expect(planSettlement(split, {}, {}).instructions).toHaveLength(2);
  });
});

describe("drivers", () => {
  it("the default refuses to pay, and says which setting to change", async () => {
    // Typed as the interface: this is how the engine holds it.
    const driver: SettlementDriver = new NoSettlementDriver();
    expect(driver.name).toBe("none");
    await expect(
      driver.settle({
        rewardId: "rw_1",
        jobId: "job_1",
        role: "AGENT",
        payee: "x",
        amount: 1,
        currency: "USDC",
      }),
    ).rejects.toThrow(/SETTLEMENT_DRIVER/);
  });

  it("the ledger driver derives its reference from the reward", async () => {
    const instruction = {
      rewardId: "rw_1",
      jobId: "job_1",
      role: "AGENT" as const,
      payee: "wallet",
      amount: 1,
      currency: "USDC",
    };
    const first = await new LedgerSettlementDriver().settle(instruction);
    const second = await new LedgerSettlementDriver().settle(instruction);

    // Replaying a sweep must not look like a second, different payment.
    expect(first.reference).toBe("ledger:rw_1");
    expect(second.reference).toBe(first.reference);
    expect(first.status).toBe("CONFIRMED");
  });

  it("is selected by the environment, and refuses an unknown name", () => {
    expect(createSettlementDriver({} as NodeJS.ProcessEnv).name).toBe("none");
    expect(createSettlementDriver({ SETTLEMENT_DRIVER: "none" } as never).name).toBe("none");
    expect(createSettlementDriver({ SETTLEMENT_DRIVER: " Ledger " } as never).name).toBe("ledger");
    // Naming a chain that is not implemented must fail loudly, not fall back
    // to a driver that quietly does nothing.
    expect(() => createSettlementDriver({ SETTLEMENT_DRIVER: "solana-mainnet" } as never)).toThrow(
      /not implemented|Supported/,
    );
  });

  it("reads the address book from the environment", () => {
    const book = addressBookFrom({
      SETTLEMENT_VALIDATOR_ADDRESS: "v",
      SETTLEMENT_TREASURY_ADDRESS: "t",
    } as never);

    expect(book).toEqual({ VALIDATOR: "v", PROTOCOL: null, TREASURY: "t" });
  });
});
