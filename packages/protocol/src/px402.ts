/**
 * px402 readiness, assessed rather than assumed.
 *
 * px402 is a zero-knowledge privacy layer over x402: a payer deposits USDC,
 * receives a note, and spends from it through a fresh burner wallet each time,
 * so payments cannot be linked to each other or to an identity. That is the
 * capability phase 5 of the roadmap reserves a slot for — an agent's
 * transaction history otherwise reveals what it buys and who it trusts.
 *
 * It is deliberately **not** wired into the payment path here, and this module
 * exists to say exactly why rather than leaving the question to be re-derived.
 * Two findings decide it, both read from `@prxvt/sdk@1.0.2` itself rather than
 * from its documentation.
 *
 * The chains are fixed in the package, not configured. `utils.js` carries
 * chain ids 8453 and 137 and the pool contracts for each. There is no
 * configuration that points it at another chain, so an installation settling
 * anywhere else cannot be paid through it — which is a fact about the two
 * projects, not a gap in this one.
 *
 * Paying through it means trusting services none of which are ours. The
 * proving key and circuit are fetched over the network at payment time, and an
 * attestor, a bundler and a subgraph all sit in the path. Every one of them is
 * a party that can stop a payment, and the circuit is a party that can change
 * what a proof means. This repository refuses to start without an explicit
 * chain id and token contract for exactly this class of reason; taking a
 * silent runtime dependency on a proving key would be the same mistake with a
 * longer fuse.
 *
 * None of that is an argument against px402. It is the argument for reporting
 * readiness honestly until the two sides can actually meet.
 */

/** Chain ids hardcoded in the SDK. Read from the package, not the docs. */
export const PX402_CHAINS: ReadonlyArray<{ id: number; name: string }> = [
  { id: 8453, name: "Base" },
  { id: 137, name: "Polygon" },
];

/**
 * Third-party services a px402 payment passes through.
 *
 * Listed because "private" describes what the chain observer learns, not how
 * many parties are involved. Anyone weighing this should see the count.
 */
export const PX402_DEPENDENCIES: ReadonlyArray<{ host: string; role: string }> = [
  { host: "circuits.prxvt.com", role: "proving key and circuit, fetched at payment time" },
  { host: "attestor.prxvt.com", role: "nullifier attestation" },
  { host: "sdk-api.prxvt.com", role: "ERC-4337 bundler" },
  { host: "api.studio.thegraph.com", role: "privacy-pool subgraph" },
];

export type Px402BlockerCode = "PAYWALL_OFF" | "NO_CHAIN" | "CHAIN_UNSUPPORTED";

export interface Px402Blocker {
  code: Px402BlockerCode;
  /** What is true now. */
  observed: string;
  /** What would have to change, stated as an action rather than a wish. */
  remedy: string;
}

export interface Px402Assessment {
  /** Whether a px402 payer could pay this installation as configured today. */
  reachable: boolean;
  /** The chain this installation quotes x402 challenges on, when it has one. */
  chainId: number | null;
  chainName: string | null;
  blockers: Px402Blocker[];
  dependencies: typeof PX402_DEPENDENCIES;
  supportedChains: typeof PX402_CHAINS;
}

/**
 * Reads the installation's own x402 configuration and reports whether a px402
 * payer could reach it.
 *
 * Pure over the environment — no database, no network — so the rules can be
 * tested without either, and so a dashboard asking this question cannot make a
 * request to prxvt.com on a page load.
 */
export function assessPx402(env: NodeJS.ProcessEnv = process.env): Px402Assessment {
  const blockers: Px402Blocker[] = [];

  const enabled = (env["X402_ENABLED"] ?? "false").trim().toLowerCase() === "true";
  const raw = Number(env["X402_CHAIN_ID"]);
  const chainId = Number.isInteger(raw) && raw > 0 ? raw : null;

  if (!enabled) {
    blockers.push({
      code: "PAYWALL_OFF",
      observed: "x402 is disabled, so nothing here quotes a payment challenge at all.",
      remedy: "Set X402_ENABLED=true, with the chain id, RPC, asset and payee it requires.",
    });
  }

  if (chainId === null) {
    blockers.push({
      code: "NO_CHAIN",
      observed: "No X402_CHAIN_ID is set, so there is no chain to compare against.",
      remedy: "Set X402_CHAIN_ID to the chain challenges settle on.",
    });
  } else if (!PX402_CHAINS.some((chain) => chain.id === chainId)) {
    blockers.push({
      code: "CHAIN_UNSUPPORTED",
      observed: `Challenges are quoted on chain ${chainId}; px402 ships pools for ${PX402_CHAINS.map((c) => `${c.name} (${c.id})`).join(" and ")} only.`,
      // Said plainly: this is not a setting either side can change.
      remedy:
        "Wait for px402 to add this chain, or settle on one it already supports. " +
        "The chain ids are compiled into the SDK, so neither side can configure around it.",
    });
  }

  return {
    reachable: blockers.length === 0,
    chainId,
    chainName: PX402_CHAINS.find((chain) => chain.id === chainId)?.name ?? null,
    blockers,
    dependencies: PX402_DEPENDENCIES,
    supportedChains: PX402_CHAINS,
  };
}
