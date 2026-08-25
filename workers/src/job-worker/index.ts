import { QUEUES, type Subscription } from "@averis/queue";
import { ExecutionPipeline, JobEngine, type ProtocolContext } from "@averis/protocol";

/**
 * Drives a queued job through agent selection and parallel execution.
 *
 * Concurrency is per-worker, so scaling out is a matter of running more worker
 * processes against the same Redis queue.
 */
export function startJobWorker(ctx: ProtocolContext): Subscription {
  const pipeline = new ExecutionPipeline(ctx);
  const engine = new JobEngine(ctx);
  const concurrency = Number(ctx.env["JOB_WORKER_CONCURRENCY"] ?? 4);

  return ctx.queue.process<{ jobId: string }>(
    QUEUES.job,
    async (message) => {
      const { jobId } = message.payload;
      ctx.logger.info("job worker picked up job", { jobId, attempt: message.attempt });

      const result = await pipeline.runJob(jobId);
      ctx.logger.info("job execution finished", { ...result });
    },
    {
      concurrency,
      // Exhausting every retry is a terminal outcome; record it on the job
      // rather than leaving it stuck in RUNNING forever.
      onFailed: async (message, error) => {
        const { jobId } = message.payload as { jobId: string };
        ctx.logger.error("job worker exhausted retries", { jobId, error: error.message });
        await engine.fail(jobId, `execution failed: ${error.message}`);
      },
    },
  );
}
