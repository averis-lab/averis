import { describe, expect, it } from "vitest";
import {
  isPaidRoute,
  NETWORKS,
  PaymentConfigError,
  priceInBaseUnits,
  resolvePaymentConfig,
  toBaseUnits,
  type PaymentConfig,
} from "../apps/api/src/payments/config";

const enabled = {
  X402_ENABLED: "true",
  X402_PAY_TO: "9xQeWvG816bUx9EPa2mNSMh1p4hbGRQ7pd5yPeeeeeee",
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
    expect(resolvePaymentConfig({ X402_PAY_TO: "abc", X402_FACILITATOR_URL: "https://x" })).toBeNull();
  });

  it("refuses to start without somewhere to send the money", () => {
    expect(() => resolvePaymentConfig({ ...enabled, X402_PAY_TO: "  " })).toThrow(PaymentConfigError);
    expect(() => resolvePaymentConfig({ ...enabled, X402_PAY_TO: "" })).toThrow(/X402_PAY_TO/);
  });

  it("refuses to start without a facilitator", () => {
    expect(() => resolvePaymentConfig({ ...enabled, X402_FACILITATOR_URL: "" })).toThrow(
      /X402_FACILITATOR_URL/,
    );
  });

  it("names the supported networks when given one that is not", () => {
    expect(() => resolvePaymentConfig({ ...enabled, X402_NETWORK: "base" })).toThrow(
      /solana-mainnet, solana-devnet, solana-testnet/,
    );
  });

  it("defaults to devnet, USDC and a ten-cent fee", () => {
    const resolved = resolvePaymentConfig(enabled)!;
    expect(resolved.networkName).toBe("solana-devnet");
    expect(resolved.network.caip2).toBe(NETWORKS["solana-devnet"]!.caip2);
    expect(resolved.asset).toBe(NETWORKS["solana-devnet"]!.usdc);
    expect(resolved.assetDecimals).toBe(6);
    expect(resolved.priceUsd).toBe(0.1);
  });

  it("prefers the mint already configured for settlement", () => {
    const resolved = resolvePaymentConfig({ ...enabled, USDC_MINT: "SomeOtherMint111111111111" })!;
    expect(resolved.asset).toBe("SomeOtherMint111111111111");
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
