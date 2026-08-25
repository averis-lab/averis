import { QUEUES, type Subscription } from "@averis/queue";
import { EvaluationStage, JobEngine, type ProtocolContext } from "@averis/protocol";

/** Scores every submitted output, then hands the job to consensus. */
export function startEvaluationWorker(ctx: ProtocolContext): Subscription {
  const stage = new EvaluationStage(ctx);
  const engine = new JobEngine(ctx);

  return ctx.queue.process<{ jobId: string }>(
    QUEUES.evaluation,
    async (message) => {
      const { jobId } = message.payload;
      const scored = await stage.run(jobId);
      ctx.logger.info("evaluation complete", { jobId, outputsScored: scored });
    },
    {
      concurrency: 4,
      onFailed: async (message, error) => {
        const { jobId } = message.payload as { jobId: string };
        await engine.fail(jobId, `evaluation failed: ${error.message}`);
      },
    },
  );
}
