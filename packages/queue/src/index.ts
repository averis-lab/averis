import { BullMQDriver } from "./bullmq";
import { MemoryQueueDriver } from "./memory";
import { PgmqDriver } from "./pgmq";
import type { QueueDriver } from "./types";

export * from "./types";
export { MemoryQueueDriver } from "./memory";
export { BullMQDriver, type BullMQConfig } from "./bullmq";
export { PgmqDriver, type PgmqConfig, type SqlExecutor } from "./pgmq";
export { captureTraceparent, packTrace, unpackTrace } from "./trace";

/**
 * Picks a driver from the environment.
 *
 * `QUEUE_DRIVER=memory` runs the entire pipeline in one process with no
 * external queue at all, which is what makes the reference demo and CI
 * runnable anywhere. It is not durable — a crash loses queued work.
 *
 * `QUEUE_DRIVER=pgmq` is the production default now: durable, multi-process,
 * and hosted by the Postgres the application already depends on, so it adds no
 * service to run and nothing to pay for.
 *
 * `QUEUE_DRIVER=bullmq` remains for deployments that already have Redis.
 */
export function createQueueDriver(env: NodeJS.ProcessEnv = process.env): QueueDriver {
  const kind = (env["QUEUE_DRIVER"] ?? "pgmq").toLowerCase();

  if (kind === "memory") return new MemoryQueueDriver();

  if (kind === "pgmq") {
    return new PgmqDriver({
      visibilityTimeoutSec: numberOr(env["QUEUE_VISIBILITY_TIMEOUT_SEC"], 300),
      pollIntervalMs: numberOr(env["QUEUE_POLL_INTERVAL_MS"], 1_000),
    });
  }

  if (kind === "bullmq") {
    const redisUrl = env["REDIS_URL"];
    if (!redisUrl) {
      throw new Error(
        'QUEUE_DRIVER=bullmq requires REDIS_URL. Use QUEUE_DRIVER=pgmq to run the queue on Postgres instead, or QUEUE_DRIVER=memory for a single-process run.',
      );
    }
    return new BullMQDriver({ redisUrl, prefix: env["QUEUE_PREFIX"] ?? "averis" });
  }

  throw new Error(`Unknown QUEUE_DRIVER "${kind}". Expected "pgmq", "bullmq" or "memory".`);
}

function numberOr(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
