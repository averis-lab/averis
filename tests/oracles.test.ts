import { describe, expect, it, vi } from "vitest";
import {
  ChainOracle,
  PriceOracle,
  chainEndpointsFromEnv,
  optionalOracles,
} from "../packages/protocol/src/oracles";
import { OracleUnavailableError, type PendingPrediction } from "@averis/types";

const now = new Date("2026-08-27T12:00:00Z");

function prediction(
  criteria: Partial<PendingPrediction["criteria"]>,
  deadline: Date = now,
): PendingPrediction {
  return {
    id: "p1",
    claimId: "c1",
    agentId: "a1",
    statement: "s",
    confidence: 0.8,
    criteria: { metric: "spot", operator: "gt", threshold: 1, source: "price:ETH-USD", ...criteria },
    deadline,
  };
}

/** A fetch that answers from a URL-substring table and records what it was asked. */
function stubFetch(routes: { match: string; body: unknown; status?: number }[]) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const coinbase = (amount: string) => ({ match: "coinbase", body: { data: { amount } } });
const kraken = (last: string) => ({ match: "kraken", body: { result: { XETHZUSD: { c: [last] } } } });

describe("price oracle", () => {
  it("takes the median of agreeing venues", async () => {
    const { impl } = stubFetch([coinbase("2500.00"), kraken("2501.00")]);
    const oracle = new PriceOracle({ fetchImpl: impl });

    expect(await oracle.observe(prediction({}), now)).toBe(2500.5);
  });

  it("resolves from one venue when the other is down", async () => {
    const { impl } = stubFetch([coinbase("2500.00"), { match: "kraken", body: {}, status: 503 }]);
    const oracle = new PriceOracle({ fetchImpl: impl });

    expect(await oracle.observe(prediction({}), now)).toBe(2500);
  });

  /*
   * The property that matters most: a wrong observation is worse than none,
   * because it moves an agent's accuracy in a direction it did not earn.
   */
  it("refuses to resolve when venues disagree beyond the spread", async () => {
    const { impl } = stubFetch([coinbase("2500.00"), kraken("3900.00")]);
    const oracle = new PriceOracle({ fetchImpl: impl });

    expect(await oracle.observe(prediction({}), now)).toBeNull();
  });

  it("defers rather than resolving when every venue is down", async () => {
    const { impl } = stubFetch([
      { match: "coinbase", body: {}, status: 503 },
      { match: "kraken", body: {}, status: 503 },
    ]);
    const oracle = new PriceOracle({ fetchImpl: impl });

    await expect(oracle.observe(prediction({}), now)).rejects.toBeInstanceOf(
      OracleUnavailableError,
    );
  });

  it("ignores a venue quoting zero rather than letting it drag the median", async () => {
    const { impl } = stubFetch([coinbase("2500.00"), kraken("0")]);
    const oracle = new PriceOracle({ fetchImpl: impl });

    expect(await oracle.observe(prediction({}), now)).toBe(2500);
  });

  it("refuses a deadline it reached too late to observe", async () => {
    const { impl, calls } = stubFetch([coinbase("2500.00"), kraken("2500.00")]);
    const oracle = new PriceOracle({ fetchImpl: impl, maxLagMs: 60_000 });

    const stale = new Date(now.getTime() - 6 * 60 * 60_000);
    expect(await oracle.observe(prediction({}, stale), now)).toBeNull();
    // And does not spend a request finding out something it cannot use.
    expect(calls).toHaveLength(0);
  });

  it("declines a metric a spot endpoint cannot answer", async () => {
    const { impl } = stubFetch([coinbase("2500.00"), kraken("2500.00")]);
    const oracle = new PriceOracle({ fetchImpl: impl });

    expect(await oracle.observe(prediction({ metric: "24h_volume" }), now)).toBeNull();
  });

  it("supports only its own source scheme", () => {
    const oracle = new PriceOracle();
    expect(oracle.supports("price:ETH-USD")).toBe(true);
    expect(oracle.supports("reppo:subnet/1")).toBe(false);
  });
});

describe("chain oracle", () => {
  const endpoints = { 4663: ["https://rpc.example.test"] };
  const hex = (value: bigint) => "0x" + value.toString(16);
  const rpc = (result: string) => ({ match: "rpc.example", body: { jsonrpc: "2.0", id: 1, result } });

  const at = (metric: string, address?: string): PendingPrediction =>
    prediction({ metric, source: `chain:4663${address ? `:${address}` : ""}` });

  it("reads the head block", async () => {
    const { impl } = stubFetch([rpc("0x2d18dae")]);
    const oracle = new ChainOracle({ endpoints, fetchImpl: impl });

    expect(await oracle.observe(at("block_number"), now)).toBe(0x2d18dae);
  });

  it("scales a native balance out of wei", async () => {
    const { impl } = stubFetch([rpc(hex(2_500_000_000_000_000_000n))]);
    const oracle = new ChainOracle({ endpoints, fetchImpl: impl });

    expect(await oracle.observe(at("native_balance", "0x" + "a".repeat(40)), now)).toBe(2.5);
  });

  /*
   * Assuming 18 would be wrong by twelve orders of magnitude for USDC, so the
   * contract is asked rather than guessed at.
   */
  it("scales an ERC-20 supply by the decimals the contract reports", async () => {
    const token = "0x" + "b".repeat(40);
    const impl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }, string] };
      const data = body.params[0].data;
      // decimals() -> 6, totalSupply() -> 1_000_000 * 10^6
      const result = data === "0x313ce567" ? hex(6n) : hex(1_000_000_000_000n);
      return new Response(JSON.stringify({ result }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const oracle = new ChainOracle({ endpoints, fetchImpl: impl });
    expect(await oracle.observe(at("erc20_total_supply", token), now)).toBe(1_000_000);
  });

  it("keeps the integer part of a supply too large for a double", async () => {
    const token = "0x" + "c".repeat(40);
    const impl = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { params: [{ data: string }, string] };
      const decimals = body.params[0].data === "0x313ce567";
      // 123,456,789,012,345 tokens at 18 decimals.
      const result = decimals ? hex(18n) : hex(123_456_789_012_345n * 10n ** 18n);
      return new Response(JSON.stringify({ result }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const oracle = new ChainOracle({ endpoints, fetchImpl: impl });
    expect(await oracle.observe(at("erc20_total_supply", token), now)).toBe(123_456_789_012_345);
  });

  /*
   * An unreachable node says nothing about the value, so the prediction must
   * survive to be tried again rather than being scored away.
   */
  it("defers rather than resolving when every endpoint fails", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ error: { message: "metadata is not found" } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const oracle = new ChainOracle({ endpoints, fetchImpl: impl });
    await expect(oracle.observe(at("block_number"), now)).rejects.toBeInstanceOf(
      OracleUnavailableError,
    );
  });

  it("still declines outright once it is too late, so a retry loop terminates", async () => {
    const impl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const oracle = new ChainOracle({ endpoints, fetchImpl: impl, maxLagMs: 60_000 });

    const stale = prediction(
      { metric: "block_number", source: "chain:4663" },
      new Date(now.getTime() - 60 * 60_000),
    );
    expect(await oracle.observe(stale, now)).toBeNull();
  });

  it("declines a metric needing an address when none was given", async () => {
    const { impl } = stubFetch([rpc("0x1")]);
    const oracle = new ChainOracle({ endpoints, fetchImpl: impl });

    expect(await oracle.observe(at("native_balance"), now)).toBeNull();
  });

  /*
   * Claiming a chain with no endpoint would turn a missing setting into failed
   * resolutions, where declining produces a clean "no oracle supports this".
   */
  it("supports only chains it has an endpoint for", () => {
    const oracle = new ChainOracle({ endpoints });
    expect(oracle.supports("chain:4663")).toBe(true);
    expect(oracle.supports("chain:4663:0xabc")).toBe(true);
    expect(oracle.supports("chain:1")).toBe(false);
    expect(oracle.supports("price:ETH-USD")).toBe(false);
  });

  it("refuses a deadline it reached too late to observe", async () => {
    const { impl, calls } = stubFetch([rpc("0x1")]);
    const oracle = new ChainOracle({ endpoints, fetchImpl: impl, maxLagMs: 60_000 });

    const stale = prediction(
      { metric: "block_number", source: "chain:4663" },
      new Date(now.getTime() - 60 * 60_000),
    );
    expect(await oracle.observe(stale, now)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("chain endpoints from the environment", () => {
  it("reads one comma-separated variable per chain", () => {
    expect(
      chainEndpointsFromEnv({
        ORACLE_RPC_4663: "https://a.test, https://b.test",
        ORACLE_RPC_8453: "https://c.test",
        ORACLE_PRICE_ENABLED: "true",
        PATH: "/usr/bin",
      } as NodeJS.ProcessEnv),
    ).toEqual({ 4663: ["https://a.test", "https://b.test"], 8453: ["https://c.test"] });
  });

  it("drops entries that are not http endpoints", () => {
    expect(
      chainEndpointsFromEnv({ ORACLE_RPC_1: "not-a-url", ORACLE_RPC_2: "" } as NodeJS.ProcessEnv),
    ).toEqual({});
  });
});

/*
 * Registration is centralised so the worker and the `resolve` script cannot
 * disagree about which oracles are live. A script verifying a set production
 * does not run is the specific way a check like that stops being worth
 * anything.
 */
describe("oracle registration", () => {
  const names = (env: NodeJS.ProcessEnv) => optionalOracles(env).map((o) => o.name);

  it("registers nothing when nothing is configured", () => {
    expect(names({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("adds price only when explicitly enabled", () => {
    expect(names({ ORACLE_PRICE_ENABLED: "true" } as NodeJS.ProcessEnv)).toContain("price");
    // Anything other than an explicit opt-in leaves it out: reaching public
    // market APIs is not something a deployment should start doing by typo.
    expect(names({ ORACLE_PRICE_ENABLED: "1" } as NodeJS.ProcessEnv)).not.toContain("price");
    expect(names({} as NodeJS.ProcessEnv)).not.toContain("price");
  });

  it("adds chain only once an endpoint exists for some chain", () => {
    expect(names({ ORACLE_RPC_4663: "https://rpc.test" } as NodeJS.ProcessEnv)).toContain("chain");
    expect(names({ ORACLE_RPC_4663: "" } as NodeJS.ProcessEnv)).not.toContain("chain");
  });

  it("registers both when everything is configured", () => {
    expect(
      names({
        ORACLE_PRICE_ENABLED: "true",
        ORACLE_RPC_4663: "https://rpc.test",
      } as NodeJS.ProcessEnv),
    ).toEqual(["price", "chain"]);
  });
});
