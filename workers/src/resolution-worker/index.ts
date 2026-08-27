import { QUEUES, type Subscription } from "@averis/queue";
import { traced } from "../traced";
import {
  ChainOracle,
  CurationOracle,
  PriceOracle,
  ResolutionStage,
  RewardStage,
  chainEndpointsFromEnv,
  type ProtocolContext,
} from "@averis/protocol";
import type { ResolutionOracle } from "@averis/types";

export interface ResolutionWorkerHandle {
  subscription: Subscription;
  /** Stops the periodic prediction sweep. */
  stop(): void;
}

/**
 * The oracles this deployment can actually answer with.
 *
 * Each is registered only when it is configured, and that is the point: an
 * oracle that claims a source it cannot reach turns a missing setting into a
 * run of failed resolutions, where leaving it out produces the correct and
 * legible "no oracle supports this source" instead.
 *
 * Curation needs nothing — it reads the data network the protocol already
 * talks to. Price is opt-in because it reaches public market APIs, which an
 * air-gapped or offline deployment should not be doing silently. Chain appears
 * only once at least one `ORACLE_RPC_<chainId>` is set.
 */
function buildOracles(ctx: ProtocolContext): ResolutionOracle[] {
  const oracles: ResolutionOracle[] = [new CurationOracle(ctx)];

  if (ctx.env["ORACLE_PRICE_ENABLED"] === "true") {
    oracles.push(new PriceOracle({ logger: ctx.logger }));
  }

  const endpoints = chainEndpointsFromEnv(ctx.env);
  if (Object.keys(endpoints).length > 0) {
    oracles.push(new ChainOracle({ endpoints, logger: ctx.logger }));
  }

  ctx.logger.info("resolution oracles registered", { oracles: oracles.map((o) => o.name) });
  return oracles;
}

/**
 * Two jobs, both post-resolution:
 *  * reward accounting for a job that just resolved (queue-driven), and
 *  * the periodic sweep that resolves predictions whose deadline has passed.
 *
 * The sweep is time-driven rather than queue-driven because a prediction's
 * deadline can be weeks out, and holding a delayed queue message for weeks is
 * a worse failure mode than scanning for due rows.
 */
export function startResolutionWorker(ctx: ProtocolContext): ResolutionWorkerHandle {
  const rewards = new RewardStage(ctx);
  const resolution = new ResolutionStage(ctx, buildOracles(ctx));

  const subscription = ctx.queue.process<{ jobId: string }>(
    QUEUES.resolution,
    traced(ctx, QUEUES.resolution, async (message) => {
      const { jobId } = message.payload;
      await rewards.run(jobId);
      ctx.logger.info("rewards settled to pending", { jobId });
    }),
    { concurrency: 2 },
  );

  const intervalMs = Number(ctx.env["RESOLUTION_SWEEP_MS"] ?? 60_000);
  const timer = setInterval(() => {
    // A root span: the sweep is on a timer, so there is no request or message
    // upstream of it to attach to.
    void ctx.tracer
      .withSpan("resolution sweep", () => resolution.run(), {
        kind: "internal",
        root: true,
      })
      .then((result) => {
        if (result.resolved + result.unresolvable + result.deferred > 0) {
          ctx.logger.info("prediction sweep", result);
        }
      })
      .catch((error: unknown) => {
        ctx.logger.error("prediction sweep failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, intervalMs);

  // Never hold the process open on the sweep alone.
  timer.unref?.();

  return { subscription, stop: () => clearInterval(timer) };
}
