import { QUEUES, type Subscription } from "@averis/queue";
import { traced } from "../traced";
import {
  ResolutionStage,
  RewardStage,
  createOracles,
  type ProtocolContext,
} from "@averis/protocol";

export interface ResolutionWorkerHandle {
  subscription: Subscription;
  /** Stops the periodic prediction sweep. */
  stop(): void;
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
  const oracles = createOracles(ctx);
  ctx.logger.info("resolution oracles registered", { oracles: oracles.map((o) => o.name) });
  const resolution = new ResolutionStage(ctx, oracles);

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
