/**
 * x402 payment configuration.
 *
 * Kept free of the x402 SDK so the price rules can be tested without a wallet,
 * a facilitator or a network — and so an installation that never turns
 * payments on never loads the SDK at all.
 *
 * Payments are **off** unless `X402_ENABLED=true`. Turning them on requires a
 * recipient address; there is no default, because a default would either be
 * somebody else's wallet or a silent misconfiguration that looks like it works.
 */

export interface SolanaNetwork {
  /** CAIP-2 identifier the x402 protocol uses on the wire. */
  caip2: `${string}:${string}`;
  /** Canonical USDC mint for this cluster. */
  usdc: string;
  rpcUrl: string;
}

export const NETWORKS: Record<string, SolanaNetwork> = {
  "solana-mainnet": {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    rpcUrl: "https://api.mainnet-beta.solana.com",
  },
  "solana-devnet": {
    caip2: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    rpcUrl: "https://api.devnet.solana.com",
  },
  "solana-testnet": {
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    usdc: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    rpcUrl: "https://api.testnet.solana.com",
  },
};

/** USDC is six decimals on every cluster; overridable for a non-USDC mint. */
const DEFAULT_DECIMALS = 6;

export interface PaymentConfig {
  network: SolanaNetwork;
  networkName: string;
  payTo: string;
  facilitatorUrl: string;
  asset: string;
  assetDecimals: number;
  /**
   * Flat access fee per job, in whole units of the asset.
   *
   * Flat, and not derived from the job's declared budget, because the price
   * has to be quoted before Fastify parses the request body — the x402 hook
   * runs at `onRequest`. Charging a budget read from the query string instead
   * would be quotable but not enforceable: settlement happens before the
   * handler ever sees the body, so an underpaying caller would have to be
   * refunded rather than refused.
   */
  priceUsd: number;
  maxTimeoutSeconds: number;
  /** Root keys skip the paywall: the operator's own workers must not pay it. */
  rootKeys: string[];
}

export class PaymentConfigError extends Error {}

/** The one route behind the paywall. Creating work costs; reading it does not. */
export function isPaidRoute(method: string, url: string): boolean {
  return method.toUpperCase() === "POST" && url.split("?")[0] === "/v1/jobs";
}

/**
 * Reads the environment into a config, or null when payments are disabled.
 *
 * Throws rather than falling back when payments are on but a required value is
 * missing: a paywall that quietly lets everything through is worse than one
 * that refuses to start.
 */
export function resolvePaymentConfig(
  env: NodeJS.ProcessEnv,
  rootKeys: string[] = [],
): PaymentConfig | null {
  if ((env["X402_ENABLED"] ?? "false").toLowerCase() !== "true") return null;

  const networkName = env["X402_NETWORK"] ?? "solana-devnet";
  const network = NETWORKS[networkName];
  if (!network) {
    throw new PaymentConfigError(
      `X402_NETWORK="${networkName}" is not supported. Use one of: ${Object.keys(NETWORKS).join(", ")}.`,
    );
  }

  const payTo = (env["X402_PAY_TO"] ?? "").trim();
  if (!payTo) {
    throw new PaymentConfigError("X402_ENABLED=true requires X402_PAY_TO — the address payments settle to.");
  }

  const facilitatorUrl = (env["X402_FACILITATOR_URL"] ?? "").trim();
  if (!facilitatorUrl) {
    throw new PaymentConfigError(
      "X402_ENABLED=true requires X402_FACILITATOR_URL — the service that verifies and settles payments.",
    );
  }

  const config: PaymentConfig = {
    network,
    networkName,
    payTo,
    facilitatorUrl,
    // USDC_MINT already exists for the settlement scaffolding; reuse it before
    // falling back to the cluster's canonical mint.
    asset: (env["X402_ASSET"] ?? env["USDC_MINT"] ?? network.usdc).trim(),
    assetDecimals: positive(env["X402_ASSET_DECIMALS"], DEFAULT_DECIMALS),
    priceUsd: positive(env["X402_PRICE"], 0.1),
    maxTimeoutSeconds: positive(env["X402_MAX_TIMEOUT_SECONDS"], 120),
    rootKeys,
  };

  return config;
}

/** The access fee in the asset's base units, as the challenge quotes it. */
export function priceInBaseUnits(config: PaymentConfig): string {
  return toBaseUnits(config.priceUsd, config.assetDecimals);
}

/**
 * Decimal string → integer base units, without floating point.
 *
 * `0.07 * 1e6` is 70000.00000000001 in IEEE-754, and a payment amount that is
 * one unit off is a payment that fails to verify.
 */
export function toBaseUnits(amountUsd: number, decimals: number): string {
  const [whole = "0", fraction = ""] = amountUsd.toFixed(decimals).split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0")).toString();
}

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
