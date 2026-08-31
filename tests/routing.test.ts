import { describe, expect, it } from "vitest";
import { describeRouting } from "../packages/protocol/src/routing";

const on = {
  X402_ENABLED: "true",
  X402_PAY_TO: "0x1111111111111111111111111111111111111111",
  X402_CHAIN_ID: "8453",
  X402_PRICE: "0.10",
} as NodeJS.ProcessEnv;

describe("payment routing", () => {
  it("reports where a buyer's payment settles", () => {
    const r = describeRouting(on);
    expect(r.inbound.enabled).toBe(true);
    expect(r.inbound.payTo).toBe("0x1111111111111111111111111111111111111111");
    expect(r.inbound.chainId).toBe(8453);
  });

  it("names no inbound address while the paywall is off", () => {
    // A configured address that nothing quotes would read as money in flight.
    const r = describeRouting({ ...on, X402_ENABLED: "false" });
    expect(r.inbound.enabled).toBe(false);
    expect(r.inbound.payTo).toBeNull();
  });

  it("takes the split from the function that actually pays, not a copy", () => {
    const shares = describeRouting(on).outbound;
    expect(shares.map((leg) => leg.role)).toEqual(["AGENT", "VALIDATOR", "PROTOCOL", "TREASURY"]);
    // Defaults are 70/15/10/5 and must sum to the whole budget.
    expect(shares.reduce((sum, leg) => sum + leg.share, 0)).toBeCloseTo(1, 10);
    expect(shares[0]?.share).toBeCloseTo(0.7, 10);
  });

  it("follows a reconfigured split rather than reporting the defaults", () => {
    const shares = describeRouting({ ...on, REWARD_SHARE_AGENTS: "0.9" }).outbound;
    // Normalised, so a changed share still sums to one budget.
    expect(shares.reduce((sum, leg) => sum + leg.share, 0)).toBeCloseTo(1, 10);
    expect(shares[0]!.share).toBeGreaterThan(0.7);
  });

  it("says agent shares have no single address, rather than showing none", () => {
    const agent = describeRouting(on).outbound[0]!;
    expect(agent.address).toBeNull();
    expect(agent.note).toMatch(/wallet its owner connected/);
  });

  it("reports the inbound address as changeable only where it is", () => {
    // Stated in the payload so a reader does not hunt for a control the UI
    // deliberately does not offer.
    expect(describeRouting(on).inbound.changeableAt).toBe("environment");
  });
});
