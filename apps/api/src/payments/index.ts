import type { FastifyInstance, FastifyRequest } from "fastify";
import { constantTimeEqual } from "../api-key";
import { extractKeyFrom } from "../auth";
import { isPaidRoute, priceInBaseUnits, type PaymentConfig } from "./config";

export { isPaidRoute, resolvePaymentConfig, PaymentConfigError } from "./config";
export type { PaymentConfig } from "./config";

/**
 * The settlement facts worth keeping. Written onto the job that the payment
 * bought, so provenance and payment sit in the same record.
 */
export interface PaymentRecord {
  protocol: "x402";
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payer: string | null;
}

/**
 * Puts `POST /v1/jobs` behind an x402 paywall.
 *
 * The SDK is imported here rather than at module scope: an installation with
 * payments off never loads it, and never pays for its dependency tree at
 * startup.
 *
 * Root keys are waived, because the operator's own workers and the demo call
 * this endpoint too; an account key is a customer and still pays.
 *
 * The fee is flat. It is quoted at `onRequest`, before Fastify has parsed the
 * body, so the job's declared budget is not available to price against — see
 * `PaymentConfig.priceUsd` for why quoting it from the query string instead
 * would not be enforceable.
 */
export async function registerPayments(app: FastifyInstance, config: PaymentConfig): Promise<void> {
  const [{ paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer }, { HTTPFacilitatorClient }, { ExactEvmScheme }] =
    await Promise.all([
      import("@x402/fastify"),
      import("@x402/core/server"),
      import("@x402/evm/exact/server"),
    ]);

  // Before anything is quoted: the RPC has to serve the chain the challenge
  // names. See `assertChainId` for why the two are not the same statement.
  await assertChainId(config);

  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });

  // The scheme is chosen by the network family, and `config.network.caip2` is
  // an `eip155:` identifier — every address the config accepts is checked as
  // `0x` + 40 hex, and the asset is an ERC-20 contract. Averis settles on
  // Robinhood Chain, so the EVM scheme is the only one that belongs here: a
  // scheme from another chain family registered against an eip155 network
  // cannot produce a payload any facilitator will verify, which is what was
  // happening before.
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network.caip2,
    new ExactEvmScheme(),
  );

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    "POST /v1/jobs": {
      description: "Create an intelligence job",
      mimeType: "application/json",
      serviceName: "averis",
      accepts: {
        scheme: "exact",
        network: config.network.caip2,
        payTo: config.payTo,
        maxTimeoutSeconds: config.maxTimeoutSeconds,
        price: { asset: config.asset, amount: priceInBaseUnits(config) },
      },
    },
  }).onProtectedRequest(async (context) => {
    const presented = extractKeyFrom((name) => context.adapter.getHeader(name));
    const isRoot = presented !== null && config.rootKeys.some((key) => constantTimeEqual(key, presented));
    return isRoot ? { grantAccess: true } : undefined;
  });

  // The resource server refuses to build a challenge for a scheme it has not
  // confirmed the facilitator supports, so this sync is mandatory rather than
  // an optimization. It is done here, at startup, for two reasons: a facilitator
  // that does not support the configured network is a configuration error and
  // should stop the gateway with that reason, and leaving it to the middleware
  // would make every request to this route — including the root-key requests
  // that skip the paywall entirely — wait on, and fail with, that same call.
  try {
    await httpServer.initialize();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `x402 is enabled but the facilitator at ${config.facilitatorUrl} could not be used: ${reason}. ` +
        `Check which pairs it supports with: curl ${config.facilitatorUrl}/supported`,
    );
  }

  // Sync is already done, so the middleware neither repeats it nor awaits it
  // per request.
  paymentMiddlewareFromHTTPServer(app, httpServer, undefined, undefined, false);

  app.log.info(
    {
      network: config.networkName,
      payTo: config.payTo,
      price: config.priceUsd,
      facilitator: config.facilitatorUrl,
    },
    "x402 payments enabled on POST /v1/jobs",
  );
}

/**
 * Checks the RPC serves the chain the configuration claims.
 *
 * `X402_RPC_URL` and `X402_CHAIN_ID` are two independent statements about the
 * same chain and nothing else compares them: the challenge quotes the id, while
 * the chain a payer's transaction actually lands on is whatever the RPC is
 * connected to. A testnet endpoint under a mainnet id looks like a working
 * paywall right up to the point where no payment ever verifies, and the
 * resulting bug reads as a facilitator problem rather than a config one.
 *
 * This is also what keeps `X402_RPC_URL` an honest requirement: the EVM scheme
 * needs no RPC of its own, so without this check the paywall would be demanding
 * a value it never used.
 */
async function assertChainId(config: PaymentConfig): Promise<void> {
  const { createPublicClient, http } = await import("viem");
  const client = createPublicClient({ transport: http(config.network.rpcUrl) });

  let served: number;
  try {
    served = await client.getChainId();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `x402 is enabled but X402_RPC_URL (${config.network.rpcUrl}) could not be reached: ${reason}`,
    );
  }

  if (served !== config.network.chainId) {
    throw new Error(
      `X402_CHAIN_ID is ${config.network.chainId} but the RPC at ${config.network.rpcUrl} serves ` +
        `chain ${served}. One of the two is wrong, and a challenge quoted for ` +
        `${config.network.caip2} would be signed against a chain this gateway is not watching.`,
    );
  }
}

/**
 * Reads what the middleware recorded for this request, if anything.
 *
 * Typed structurally rather than against the SDK so the routes stay compilable
 * with the payment packages absent.
 */
export function paymentOf(request: FastifyRequest): PaymentRecord | null {
  const context = (
    request as FastifyRequest & {
      x402Context?: {
        paymentRequirements?: { scheme?: string; network?: string; asset?: string; amount?: string };
        paymentPayload?: { payer?: string; payload?: { payer?: string } };
      };
    }
  ).x402Context;

  const requirements = context?.paymentRequirements;
  if (!requirements) return null;

  return {
    protocol: "x402",
    scheme: requirements.scheme ?? "exact",
    network: requirements.network ?? "",
    asset: requirements.asset ?? "",
    amount: requirements.amount ?? "0",
    payer: context?.paymentPayload?.payer ?? context?.paymentPayload?.payload?.payer ?? null,
  };
}
