import { splitReward } from "./reward-split";

/**
 * Where money goes, in both directions, read from configuration.
 *
 * Two flows meet in one system and are easy to confuse, so they are named
 * separately here.
 *
 * **Inbound** is the address a buyer's x402 payment settles to — one address
 * for the whole installation, set by `X402_PAY_TO`. It is environment-only and
 * deliberately has no runtime override: it is the single value that decides
 * who receives every payment this gateway takes, and a web form that could
 * change it would be a revenue-redirect switch reachable by whoever could
 * reach the form. Changing it should require the access that deploying
 * requires, which is exactly what an environment variable expresses.
 *
 * **Outbound** is a job's budget split between the agents that did the work
 * and the roles that carry the rest. Agent shares are the interesting case:
 * they go to the wallet each agent's owner *connected*, resolved from a
 * verified identity token rather than typed in — so an owner changes where
 * they are paid by connecting a different wallet, and cannot direct earnings
 * to an address they do not control.
 */

export type RewardRoleName = "AGENT" | "VALIDATOR" | "PROTOCOL" | "TREASURY";

export interface RoutingLeg {
  role: RewardRoleName;
  /** Share of a job's budget, 0..1, after normalisation. */
  share: number;
  /** Configured address, or null where none is set. */
  address: string | null;
  /** Why an address is absent, when it is. */
  note?: string;
}

export interface PaymentRouting {
  inbound: {
    enabled: boolean;
    /** Where a buyer's payment settles. Null when the paywall is off. */
    payTo: string | null;
    chainId: number | null;
    priceUsd: number | null;
    /** Stated so nobody looks for a control that should not exist. */
    changeableAt: "environment";
  };
  outbound: RoutingLeg[];
}

export function describeRouting(env: NodeJS.ProcessEnv = process.env): PaymentRouting {
  const enabled = (env["X402_ENABLED"] ?? "false").trim().toLowerCase() === "true";
  const payTo = (env["X402_PAY_TO"] ?? "").trim() || null;
  const chainRaw = Number(env["X402_CHAIN_ID"]);
  const price = Number(env["X402_PRICE"]);

  // Shares are read through the same function the pipeline pays with, over a
  // budget of 1, so this can never drift from what is actually written.
  const split = splitReward(1, env);
  const address = (key: string): string | null => (env[key] ?? "").trim() || null;

  return {
    inbound: {
      enabled,
      payTo: enabled ? payTo : null,
      chainId: Number.isInteger(chainRaw) && chainRaw > 0 ? chainRaw : null,
      priceUsd: Number.isFinite(price) && price > 0 ? price : null,
      changeableAt: "environment",
    },
    outbound: [
      {
        role: "AGENT",
        share: split.agents,
        address: null,
        note: "Each agent's share goes to the wallet its owner connected, not to one address. An agent whose owner has connected none is skipped rather than guessed.",
      },
      { role: "VALIDATOR", share: split.validators, address: address("SETTLEMENT_VALIDATOR_ADDRESS") },
      { role: "PROTOCOL", share: split.protocol, address: address("SETTLEMENT_PROTOCOL_ADDRESS") },
      { role: "TREASURY", share: split.treasury, address: address("SETTLEMENT_TREASURY_ADDRESS") },
    ],
  };
}
