import { describe, expect, it } from "vitest";
import { assessPx402, PX402_CHAINS } from "../packages/protocol/src/px402";

/**
 * The rules are read from `@prxvt/sdk@1.0.2` rather than from its docs: the
 * chain ids are compiled into the package, so this is a fact about the two
 * projects rather than a setting either of them can change.
 */
const base = {
  X402_ENABLED: "true",
  X402_CHAIN_ID: "8453",
} as NodeJS.ProcessEnv;

describe("px402 readiness", () => {
  it("is reachable on a chain px402 actually ships a pool for", () => {
    const report = assessPx402(base);
    expect(report.reachable).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.chainName).toBe("Base");
  });

  it("names the chain mismatch as the blocker it is", () => {
    // Robinhood Chain, which this repository settles on.
    const report = assessPx402({ ...base, X402_CHAIN_ID: "4663" });

    expect(report.reachable).toBe(false);
    expect(report.blockers.map((b) => b.code)).toContain("CHAIN_UNSUPPORTED");
    // The remedy must not read as a configuration change, because it is not one.
    expect(report.blockers[0]?.remedy).toMatch(/compiled into the SDK/);
    expect(report.chainName).toBeNull();
  });

  it("reports the paywall being off separately from the chain being wrong", () => {
    // Two different problems with two different fixes; collapsing them would
    // send someone to change a chain id when the paywall is simply disabled.
    const report = assessPx402({ X402_ENABLED: "false", X402_CHAIN_ID: "8453" });
    expect(report.blockers.map((b) => b.code)).toEqual(["PAYWALL_OFF"]);
  });

  it("reports an absent chain id as absent rather than as unsupported", () => {
    const report = assessPx402({ X402_ENABLED: "true" });
    expect(report.blockers.map((b) => b.code)).toEqual(["NO_CHAIN"]);
  });

  it("lists every third party a payment would pass through", () => {
    // "Private" describes what a chain observer learns, not how many parties
    // are involved. The proving key in particular is fetched at payment time.
    const hosts = assessPx402(base).dependencies.map((d) => d.host);
    expect(hosts).toContain("circuits.prxvt.com");
    expect(hosts.length).toBeGreaterThanOrEqual(4);
  });

  it("does not claim support for a chain the SDK has no pool for", () => {
    expect(PX402_CHAINS.map((c) => c.id).sort()).toEqual([137, 8453]);
  });
});
