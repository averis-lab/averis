import type { ProtocolContext } from "@averis/protocol";
import { startJobWorker } from "./job-worker/index";
import { startEvaluationWorker } from "./evaluation-worker/index";
import { startConsensusWorker } from "./consensus-worker/index";
import { startResolutionWorker } from "./resolution-worker/index";

export { startJobWorker } from "./job-worker/index";
export { startEvaluationWorker } from "./evaluation-worker/index";
export { startConsensusWorker } from "./consensus-worker/index";
export { startResolutionWorker } from "./resolution-worker/index";

export interface WorkerSet {
  /**
   * Stops every subscription and the periodic sweep.
   *
   * Deliberately does not close the queue driver or the database: with the
   * workers running inside the API process those are shared, and closing them
   * here would pull the floor out from under the HTTP server. Whoever owns the
   * process owns the shutdown.
   */
  stop(): Promise<void>;
}

/**
 * Starts all four lifecycle workers against one context.
 *
 * They are plain functions over a `ProtocolContext`, so where they run is a
 * deployment decision rather than a code one: the same call gives you a
 * dedicated worker process (`workers/src/main.ts`) or workers living inside
 * the API process (`apps/api/src/main.ts`). Sharing a context is what makes
 * the second arrangement work even with the in-memory queue driver, because
 * producer and consumer are then the same object.
 */
export function startWorkers(ctx: ProtocolContext): WorkerSet {
  const job = startJobWorker(ctx);
  const evaluation = startEvaluationWorker(ctx);
  const consensus = startConsensusWorker(ctx);
  const resolution = startResolutionWorker(ctx);

  return {
    stop: async () => {
      resolution.stop();
      await Promise.allSettled([
        job.close(),
        evaluation.close(),
        consensus.close(),
        resolution.subscription.close(),
      ]);
    },
  };
}
