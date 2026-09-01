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
import {
  EvmSettlementDriver,
  SettlementConfigError,
  evmSettlementConfigFrom,
  toBaseUnits,
} from "../packages/protocol/src/settlement-evm";

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
    expect(() => createSettlementDriver({ SETTLEMENT_DRIVER: "robinhood" } as never)).toThrow(
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

/**
 * The on-chain driver.
 *
 * Everything below runs without a chain. That is the point: the parts of a
 * settlement driver that can be wrong without the network noticing — the
 * amount, the payee, the currency, the configuration — are exactly the parts
 * that must be checked before a transaction is ever built.
 */

const EVM_PAYEE = "0x1111111111111111111111111111111111111111";
/** A base58 address from another chain family. Nothing here can pay it. */
const FOREIGN_PAYEE = "9xQeWvG816bUx9EPa2mNSMh1p4hbGRQ7pd5yPeeeeeee";

const evmEnv = (over: Record<string, string> = {}) =>
  ({
    SETTLEMENT_DRIVER: "evm",
    SETTLEMENT_RPC_URL: "https://rpc.example",
    SETTLEMENT_CHAIN_ID: "42161",
    SETTLEMENT_ASSET: "0x2222222222222222222222222222222222222222",
    SETTLEMENT_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
    ...over,
  }) as never;

const instruction = (over: Record<string, unknown> = {}) => ({
  rewardId: "rw_1",
  jobId: "job_1",
  role: "AGENT" as const,
  payee: EVM_PAYEE,
  amount: 1,
  currency: "USDC",
  ...over,
});

describe("the evm driver's configuration", () => {
  it("is built from the environment, with USDC's six decimals as the default", () => {
    const config = evmSettlementConfigFrom(evmEnv());

    expect(config.chainId).toBe(42161);
    expect(config.assetDecimals).toBe(6);
    expect(config.currency).toBe("USDC");
    expect(config.confirmations).toBe(1);
  });

  it("refuses every value that decides where money goes", () => {
    // No RPC, no chain id, no token contract, no key: each one alone is enough
    // to stop the driver being built. None of them has a default, because a
    // default here is either somebody else's address or a silent misconfiguration.
    for (const missing of [
      "SETTLEMENT_RPC_URL",
      "SETTLEMENT_CHAIN_ID",
      "SETTLEMENT_ASSET",
      "SETTLEMENT_PRIVATE_KEY",
    ]) {
      expect(() => evmSettlementConfigFrom(evmEnv({ [missing]: "" }))).toThrow(
        SettlementConfigError,
      );
    }
  });

  it("rejects an address from another chain pasted into the token field", () => {
    expect(() => evmSettlementConfigFrom(evmEnv({ SETTLEMENT_ASSET: FOREIGN_PAYEE }))).toThrow(
      /40 hex/,
    );
  });

  it("never quotes the private key back in an error", () => {
    const key = `0x${"cd".repeat(32)}`;
    // A config error is the one place a secret is most likely to reach a log,
    // because the value that failed is the natural thing to print.
    try {
      evmSettlementConfigFrom(evmEnv({ SETTLEMENT_PRIVATE_KEY: `${key}zz` }));
      expect.unreachable("a malformed key must throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(key);
      expect((error as Error).message).not.toContain("cd");
    }
  });
});

describe("the evm driver", () => {
  const driver = () => new EvmSettlementDriver(evmSettlementConfigFrom(evmEnv()));

  it("is selected by name, and a chain name is still not a driver name", () => {
    expect(createSettlementDriver(evmEnv()).name).toBe("evm");
    // The chain is chosen by SETTLEMENT_CHAIN_ID; naming it here must still fail.
    expect(() => createSettlementDriver({ SETTLEMENT_DRIVER: "robinhood" } as never)).toThrow(
      /Supported/,
    );
  });

  it("cannot be built without its configuration, rather than built and left to fail mid-sweep", () => {
    expect(() => createSettlementDriver({ SETTLEMENT_DRIVER: "evm" } as never)).toThrow(
      SettlementConfigError,
    );
  });

  it("accepts an EVM payee and refuses one from another chain", () => {
    expect(driver().acceptsPayee(EVM_PAYEE)).toBe(true);
    expect(driver().acceptsPayee(FOREIGN_PAYEE)).toBe(false);
  });

  it("refuses a payee it cannot pay before it touches the network", async () => {
    // The RPC above does not exist. Reaching it would be the failure; refusing
    // first is the behaviour.
    await expect(driver().settle(instruction({ payee: FOREIGN_PAYEE }))).rejects.toThrow(
      /not an EVM address/,
    );
  });

  it("refuses a currency it does not pay rather than converting it", async () => {
    await expect(driver().settle(instruction({ currency: "SOL" }))).rejects.toThrow(
      /no conversion is attempted/,
    );
  });

  it("refuses an amount too small for the asset to express", async () => {
    await expect(driver().settle(instruction({ amount: 1e-9 }))).rejects.toThrow(
      /nothing to send/,
    );
  });
});

describe("converting an amount to base units", () => {
  it("does not go through floating point", () => {
    // 0.07 * 1e6 is 70000.00000000001 as a double. A transfer one unit off is
    // still a transfer of the wrong amount.
    expect(toBaseUnits(0.07, 6)).toBe(70000n);
    expect(toBaseUnits(1, 6)).toBe(1_000_000n);
    expect(toBaseUnits(1.5, 6)).toBe(1_500_000n);
    expect(toBaseUnits(DUST, 6)).toBe(1n);
  });

  it("is zero for anything that cannot be sent", () => {
    expect(toBaseUnits(0, 6)).toBe(0n);
    expect(toBaseUnits(-1, 6)).toBe(0n);
    expect(toBaseUnits(Number.NaN, 6)).toBe(0n);
  });
});

describe("planning against a driver that cannot pay every address", () => {
  const onlyEvm: SettlementDriver = {
    name: "evm",
    acceptsPayee: (payee) => /^0x[0-9a-fA-F]{40}$/.test(payee),
    settle: async () => {
      throw new Error("the plan must not reach the driver");
    },
  };

  it("skips an agent whose owner registered a wallet on another chain", () => {
    const plan = planSettlement([reward({ agentPayee: FOREIGN_PAYEE })], {}, {
      acceptsPayee: onlyEvm.acceptsPayee!,
    });

    expect(plan.instructions).toHaveLength(0);
    // Reported before anything is executed, and specific enough to act on.
    expect(plan.skips[0]?.reason).toMatch(/cannot pay/);
    expect(plan.skips[0]?.reason).toContain(FOREIGN_PAYEE);
  });

  it("skips a configured role address that the driver cannot pay", () => {
    const plan = planSettlement(
      [reward({ role: "PROTOCOL", agentId: null, agentPayee: null })],
      { PROTOCOL: "not-an-address" },
      { acceptsPayee: onlyEvm.acceptsPayee! },
    );

    expect(plan.instructions).toHaveLength(0);
    expect(plan.skips[0]?.reason).toMatch(/PROTOCOL/);
  });

  it("still pays an address the driver accepts", () => {
    const plan = planSettlement([reward({ agentPayee: EVM_PAYEE })], {}, {
      acceptsPayee: onlyEvm.acceptsPayee!,
    });

    expect(plan.instructions).toHaveLength(1);
    expect(plan.instructions[0]?.payee).toBe(EVM_PAYEE);
  });

  it("checks nothing when the driver has no opinion, so ledger keeps working", () => {
    // `ledger` records payments made elsewhere, where the payee is a note
    // rather than an address anything is sent to.
    const plan = planSettlement([reward({ agentPayee: FOREIGN_PAYEE })], {}, {});
    expect(plan.instructions).toHaveLength(1);
  });
});
