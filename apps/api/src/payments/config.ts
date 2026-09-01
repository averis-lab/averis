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

export interface EvmNetwork {
  /** CAIP-2 identifier the x402 protocol uses on the wire: `eip155:<chainId>`. */
  caip2: `eip155:${number}`;
  chainId: number;
  /** USDC contract on this chain. */
  usdc: string;
  rpcUrl: string;
}

/**
 * There is no table of known networks.
 *
 * A registry would have to carry a chain id, an RPC endpoint and a token
 * contract for each entry, and a wrong token contract is not a
 * misconfiguration — it is funds sent somewhere nobody controls. The same
 * reasoning that already forbids a default `X402_PAY_TO` applies to every one
 * of those values, so all three are read from the environment and the paywall
 * refuses to start without them.
 */

/** USDC is six decimals on every EVM chain; overridable for a different token. */
const DEFAULT_DECIMALS = 6;

/** 0x followed by 20 bytes. Catches an address from another chain pasted in. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface PaymentConfig {
  network: EvmNetwork;
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

  // A label for logs and the challenge; it identifies nothing on the wire.
  const networkName = (env["X402_NETWORK"] ?? "robinhood").trim();

  const chainId = Number(env["X402_CHAIN_ID"]);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new PaymentConfigError(
      "X402_ENABLED=true requires X402_CHAIN_ID, the EVM chain id payments settle on.",
    );
  }

  const rpcUrl = (env["X402_RPC_URL"] ?? "").trim();
  if (!rpcUrl) {
    throw new PaymentConfigError("X402_ENABLED=true requires X402_RPC_URL for that chain.");
  }

  const asset = (env["X402_ASSET"] ?? env["USDC_TOKEN"] ?? "").trim();
  if (!EVM_ADDRESS.test(asset)) {
    throw new PaymentConfigError(
      "X402_ENABLED=true requires X402_ASSET, the USDC contract address on this chain, as 0x followed by 40 hex characters.",
    );
  }

  const payTo = (env["X402_PAY_TO"] ?? "").trim();
  if (!EVM_ADDRESS.test(payTo)) {
    throw new PaymentConfigError(
      "X402_ENABLED=true requires X402_PAY_TO, the address payments settle to, as 0x followed by 40 hex characters.",
    );
  }

  const facilitatorUrl = (env["X402_FACILITATOR_URL"] ?? "").trim();
  if (!facilitatorUrl) {
    throw new PaymentConfigError(
      "X402_ENABLED=true requires X402_FACILITATOR_URL — the service that verifies and settles payments.",
    );
  }

  const network: EvmNetwork = {
    caip2: `eip155:${chainId}`,
    chainId,
    usdc: asset,
    rpcUrl,
  };

  const config: PaymentConfig = {
    network,
    networkName,
    payTo,
    facilitatorUrl,
    asset,
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
