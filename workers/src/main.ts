import "@averis/db/env";
import { createContext, consoleLogger } from "@averis/protocol";
import { disconnect } from "@averis/db";
import { startJobWorker } from "./job-worker/index";
import { startEvaluationWorker } from "./evaluation-worker/index";
import { startConsensusWorker } from "./consensus-worker/index";
import { startResolutionWorker } from "./resolution-worker/index";

/**
 * Runs all four lifecycle workers in one process.
 *
 * They are separate modules with separate queues, so splitting them into
 * separate deployments later is a change to this file only.
 */
async function main(): Promise<void> {
  const ctx = createContext({ logger: consoleLogger });

  const job = startJobWorker(ctx);
  const evaluation = startEvaluationWorker(ctx);
  const consensus = startConsensusWorker(ctx);
  const resolution = startResolutionWorker(ctx);

  ctx.logger.info("workers started", {
    queue: ctx.queue.name,
    data: ctx.data.name,
    llm: process.env["LLM_PROVIDER"] ?? "mock",
  });

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info("shutting down workers", { signal });
    resolution.stop();
    await Promise.allSettled([
      job.close(),
      evaluation.close(),
      consensus.close(),
      resolution.subscription.close(),
    ]);
    await ctx.queue.close();
    await disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error("worker startup failed:", error);
  process.exit(1);
});
