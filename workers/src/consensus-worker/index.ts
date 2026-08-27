import { QUEUES, type Subscription } from "@averis/queue";
import { traced } from "../traced";
import { ConsensusStage, JobEngine, type ProtocolContext } from "@averis/protocol";

/** Merges scored outputs into the job's final intelligence. */
export function startConsensusWorker(ctx: ProtocolContext): Subscription {
  const stage = new ConsensusStage(ctx);
  const engine = new JobEngine(ctx);

  return ctx.queue.process<{ jobId: string }>(
    QUEUES.consensus,
    traced(ctx, QUEUES.consensus, async (message) => {
      const { jobId } = message.payload;
      await stage.run(jobId);
      ctx.logger.info("consensus complete", { jobId });
    }),
    {
      concurrency: 2,
      onFailed: async (message, error) => {
        const { jobId } = message.payload as { jobId: string };
        await engine.fail(jobId, `consensus failed: ${error.message}`);
      },
    },
  );
}
