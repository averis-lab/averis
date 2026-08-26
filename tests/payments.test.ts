import { describe, expect, it } from "vitest";
import {
  isPaidRoute,
  PaymentConfigError,
  priceInBaseUnits,
  resolvePaymentConfig,
  toBaseUnits,
  type PaymentConfig,
} from "../apps/api/src/payments/config";

const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const USDC = "0x0000000000000000000000000000000000000A55";

const enabled = {
  X402_ENABLED: "true",
  X402_CHAIN_ID: "42161",
  X402_RPC_URL: "https://rpc.example",
  X402_ASSET: USDC,
  X402_PAY_TO: PAY_TO,
  X402_FACILITATOR_URL: "https://facilitator.example",
} satisfies NodeJS.ProcessEnv;

const config = (overrides: Partial<PaymentConfig> = {}): PaymentConfig => ({
  ...resolvePaymentConfig(enabled)!,
  ...overrides,
});

describe("resolvePaymentConfig", () => {
  it("is off unless explicitly enabled", () => {
    expect(resolvePaymentConfig({})).toBeNull();
    expect(resolvePaymentConfig({ X402_ENABLED: "false" })).toBeNull();
    // A half-configured environment must not switch the paywall on by accident.
    expect(resolvePaymentConfig({ X402_PAY_TO: PAY_TO, X402_FACILITATOR_URL: "https://x" })).toBeNull();
  });

  it("refuses to start without somewhere to send the money", () => {
    expect(() => resolvePaymentConfig({ ...enabled, X402_PAY_TO: "  " })).toThrow(PaymentConfigError);
    expect(() => resolvePaymentConfig({ ...enabled, X402_PAY_TO: "" })).toThrow(/X402_PAY_TO/);
  });

  it("rejects an address that is not an EVM address", () => {
    // The shape a Solana address has. Accepting it would quote a challenge
    // payable to something that does not exist on this chain.
    const solana = "9xQeWvG816bUx9EPa2mNSMh1p4hbGRQ7pd5yPeeeeeee";
    expect(() => resolvePaymentConfig({ ...enabled, X402_PAY_TO: solana })).toThrow(/X402_PAY_TO/);
    expect(() => resolvePaymentConfig({ ...enabled, X402_ASSET: solana })).toThrow(/X402_ASSET/);
  });

  it("refuses to start without a chain id, an RPC and a token", () => {
    expect(() => resolvePaymentConfig({ ...enabled, X402_CHAIN_ID: "" })).toThrow(/X402_CHAIN_ID/);
    expect(() => resolvePaymentConfig({ ...enabled, X402_CHAIN_ID: "0" })).toThrow(/X402_CHAIN_ID/);
    expect(() => resolvePaymentConfig({ ...enabled, X402_RPC_URL: "" })).toThrow(/X402_RPC_URL/);
    expect(() => resolvePaymentConfig({ ...enabled, X402_ASSET: "" })).toThrow(/X402_ASSET/);
  });

  it("refuses to start without a facilitator", () => {
    expect(() => resolvePaymentConfig({ ...enabled, X402_FACILITATOR_URL: "" })).toThrow(
      /X402_FACILITATOR_URL/,
    );
  });

  it("builds the CAIP-2 identifier from the chain id", () => {
    const resolved = resolvePaymentConfig(enabled)!;
    expect(resolved.networkName).toBe("robinhood");
    expect(resolved.network.chainId).toBe(42161);
    expect(resolved.network.caip2).toBe("eip155:42161");
    expect(resolved.asset).toBe(USDC);
    expect(resolved.assetDecimals).toBe(6);
    expect(resolved.priceUsd).toBe(0.1);
  });

  it("takes the label from the environment without letting it change the chain", () => {
    const resolved = resolvePaymentConfig({ ...enabled, X402_NETWORK: "robinhood-testnet" })!;
    expect(resolved.networkName).toBe("robinhood-testnet");
    expect(resolved.network.caip2).toBe("eip155:42161");
  });

  it("falls back to the token already configured for settlement", () => {
    const { X402_ASSET: _unused, ...withoutAsset } = enabled;
    const resolved = resolvePaymentConfig({ ...withoutAsset, USDC_TOKEN: USDC })!;
    expect(resolved.asset).toBe(USDC);
  });

  it("carries the root keys that may skip the paywall", () => {
    expect(resolvePaymentConfig(enabled, ["root-key"])!.rootKeys).toEqual(["root-key"]);
  });

  it("ignores nonsense numbers rather than charging them", () => {
    // A price of "abc" or "-3" must not become a free or negative charge.
    expect(resolvePaymentConfig({ ...enabled, X402_PRICE: "not-a-number" })!.priceUsd).toBe(0.1);
    expect(resolvePaymentConfig({ ...enabled, X402_PRICE: "-3" })!.priceUsd).toBe(0.1);
    expect(resolvePaymentConfig({ ...enabled, X402_PRICE: "0" })!.priceUsd).toBe(0.1);
    expect(resolvePaymentConfig({ ...enabled, X402_PRICE: "2.5" })!.priceUsd).toBe(2.5);
  });
});

describe("priceInBaseUnits", () => {
  it("quotes the configured fee in the asset's base units", () => {
    expect(priceInBaseUnits(config())).toBe("100000");
    expect(priceInBaseUnits(config({ priceUsd: 2.5 }))).toBe("2500000");
    expect(priceInBaseUnits(config({ priceUsd: 0.01 }))).toBe("10000");
  });

  it("follows a non-USDC decimal scale", () => {
    expect(priceInBaseUnits(config({ priceUsd: 1.5, assetDecimals: 9 }))).toBe("1500000000");
  });
});

describe("toBaseUnits", () => {
  it("converts without floating point drift", () => {
    // 0.07 * 1e6 is 70000.00000000001 in IEEE-754; one unit off fails to verify.
    expect(toBaseUnits(0.07, 6)).toBe("70000");
    expect(toBaseUnits(1.1, 6)).toBe("1100000");
    expect(toBaseUnits(0.000001, 6)).toBe("1");
    expect(toBaseUnits(3, 6)).toBe("3000000");
    expect(toBaseUnits(1234.567891, 6)).toBe("1234567891");
  });

  it("handles other decimal scales", () => {
    expect(toBaseUnits(1.5, 9)).toBe("1500000000");
    expect(toBaseUnits(2, 0)).toBe("2");
  });
});

describe("isPaidRoute", () => {
  it("gates job creation only", () => {
    expect(isPaidRoute("POST", "/v1/jobs")).toBe(true);
    expect(isPaidRoute("post", "/v1/jobs?dry=1")).toBe(true);
    // Reading is free; so is everything else.
    expect(isPaidRoute("GET", "/v1/jobs")).toBe(false);
    expect(isPaidRoute("GET", "/v1/jobs/abc/intelligence")).toBe(false);
    expect(isPaidRoute("POST", "/v1/agents")).toBe(false);
    expect(isPaidRoute("POST", "/health")).toBe(false);
  });
});
