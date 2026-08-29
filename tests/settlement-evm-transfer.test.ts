import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EvmSettlementDriver,
  evmSettlementConfigFrom,
} from "../packages/protocol/src/settlement-evm";

/**
 * The transfer path, actually executed.
 *
 * `settlement.test.ts` covers the rules that can be checked without a chain.
 * This file covers the part that could not be tested that way and is exactly
 * the part the protocol docs warned about: a transfer path that has never run
 * is code that looks ready to move money and has never moved any.
 *
 * The chain here is a JSON-RPC server on loopback, so no infrastructure and no
 * funds are needed — but everything above the socket is real. viem builds,
 * signs and serialises a genuine EIP-1559 transaction, and the assertions read
 * the signed bytes back to confirm the calldata says what the reward said.
 */

const CHAIN_ID = 42161;
const TX_HASH = `0x${"ab".repeat(32)}`;
const ASSET = "0x2222222222222222222222222222222222222222";
const PAYEE = "0x1111111111111111111111111111111111111111";

/** Knobs the individual tests turn to steer the mock chain. */
const chain = {
  servedChainId: CHAIN_ID,
  receiptStatus: "0x1",
  callReverts: false,
};

/** What the mock chain was asked, and what it was handed to broadcast. */
const traffic: { methods: string[]; rawTransaction: string | null } = {
  methods: [],
  rawTransaction: null,
};

let server: Server;
let rpcUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const answer = (request: { method: string; params?: unknown[]; id: number }) => {
        traffic.methods.push(request.method);
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });

        switch (request.method) {
          case "eth_chainId":
            return ok(`0x${chain.servedChainId.toString(16)}`);
          case "eth_blockNumber":
            return ok("0x64");
          case "eth_getTransactionCount":
            return ok("0x7");
          case "eth_estimateGas":
            return ok("0xdbba0");
          case "eth_maxPriorityFeePerGas":
            return ok("0x5f5e100");
          case "eth_gasPrice":
            return ok("0x3b9aca00");
          case "eth_getBlockByNumber":
            return ok({
              number: "0x64",
              baseFeePerGas: "0x3b9aca00",
              timestamp: "0x1",
              hash: `0x${"11".repeat(32)}`,
              transactions: [],
            });
          case "eth_call":
            if (chain.callReverts) {
              return {
                jsonrpc: "2.0",
                id: request.id,
                error: {
                  code: 3,
                  message: "execution reverted: ERC20: transfer amount exceeds balance",
                },
              };
            }
            // ERC-20 `transfer` returning true.
            return ok(`0x${"0".repeat(63)}1`);
          case "eth_sendRawTransaction":
            traffic.rawTransaction = (request.params?.[0] as string) ?? null;
            return ok(TX_HASH);
          case "eth_getTransactionReceipt":
            return ok({
              transactionHash: TX_HASH,
              blockNumber: "0x65",
              blockHash: `0x${"22".repeat(32)}`,
              status: chain.receiptStatus,
              gasUsed: "0xcf08",
              cumulativeGasUsed: "0xcf08",
              logs: [],
              logsBloom: `0x${"0".repeat(512)}`,
              type: "0x2",
              transactionIndex: "0x0",
              from: `0x${"33".repeat(20)}`,
              to: ASSET,
              contractAddress: null,
              effectiveGasPrice: "0x3b9aca00",
            });
          default:
            return {
              jsonrpc: "2.0",
              id: request.id,
              error: { code: -32601, message: `no mock for ${request.method}` },
            };
        }
      };

      const parsed = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
});

const driver = (over: Record<string, string> = {}) =>
  new EvmSettlementDriver(
    evmSettlementConfigFrom({
      SETTLEMENT_RPC_URL: rpcUrl,
      SETTLEMENT_CHAIN_ID: String(CHAIN_ID),
      SETTLEMENT_ASSET: ASSET,
      SETTLEMENT_PRIVATE_KEY: `0x${"ab".repeat(32)}`,
      SETTLEMENT_CONFIRMATION_TIMEOUT_MS: "5000",
      ...over,
    } as never),
  );

const instruction = {
  rewardId: "rw_1",
  jobId: "job_1",
  role: "AGENT" as const,
  payee: PAYEE,
  amount: 1.05,
  currency: "USDC",
};

describe("paying a reward on chain", () => {
  it("signs a transfer for the amount the reward owed and confirms it", async () => {
    traffic.methods = [];
    const receipt = await driver().settle(instruction);

    expect(receipt.status).toBe("CONFIRMED");
    expect(receipt.reference).toBe(TX_HASH);
    // 1.05 USDC at six decimals, arrived at without floating point.
    expect(receipt.detail?.["amount"]).toBe("1050000");
    expect(receipt.detail?.["blockNumber"]).toBe("101");

    // The signed bytes are the claim worth checking: everything else could be
    // right while the transaction says something else entirely.
    const signed = (traffic.rawTransaction ?? "").toLowerCase();
    expect(signed.length).toBeGreaterThan(200);
    expect(signed).toContain("a9059cbb"); // transfer(address,uint256)
    expect(signed).toContain(PAYEE.slice(2).toLowerCase());
    expect(signed).toContain("100590"); // 1050000
  });

  it("simulates before it broadcasts", async () => {
    traffic.methods = [];
    await driver().settle(instruction);

    expect(traffic.methods.indexOf("eth_call")).toBeGreaterThanOrEqual(0);
    expect(traffic.methods.indexOf("eth_call")).toBeLessThan(
      traffic.methods.indexOf("eth_sendRawTransaction"),
    );
  });

  it("broadcasts nothing when the simulation reverts", async () => {
    chain.callReverts = true;
    traffic.methods = [];
    traffic.rawTransaction = null;

    // Insufficient balance is the ordinary case here, and it must cost no gas
    // and leave the reward retryable.
    await expect(driver().settle(instruction)).rejects.toThrow();
    expect(traffic.methods).not.toContain("eth_sendRawTransaction");
    expect(traffic.rawTransaction).toBeNull();

    chain.callReverts = false;
  });

  it("treats a reverted transaction as a failure, never as a settlement", async () => {
    chain.receiptStatus = "0x0";

    // The hash has to survive into the error: it is the only handle anyone has
    // on a transaction that is already public.
    await expect(driver().settle(instruction)).rejects.toThrow(TX_HASH);
    await expect(driver().settle(instruction)).rejects.toThrow(/reverted/);

    chain.receiptStatus = "0x1";
  });

  it("refuses to pay when the RPC serves a different chain than configured", async () => {
    chain.servedChainId = 1;
    traffic.methods = [];

    await expect(driver().settle(instruction)).rejects.toThrow(/serves chain 1/);
    expect(traffic.methods).not.toContain("eth_sendRawTransaction");

    chain.servedChainId = CHAIN_ID;
  });

  it("names an unreachable RPC, and retries it rather than caching the failure", async () => {
    // Port 1 is not listening. The connection is cached as a promise, so a
    // transient RPC outage at the first sweep must not poison every later one.
    const unreachable = driver({ SETTLEMENT_RPC_URL: "http://127.0.0.1:1" });

    await expect(unreachable.settle(instruction)).rejects.toThrow(/could not be reached/);
    await expect(unreachable.settle(instruction)).rejects.toThrow(/could not be reached/);
  });
});
