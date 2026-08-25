import { BullMQDriver } from "./bullmq";
import { MemoryQueueDriver } from "./memory";
import type { QueueDriver } from "./types";

export * from "./types";
export { MemoryQueueDriver } from "./memory";
export { BullMQDriver, type BullMQConfig } from "./bullmq";

/**
 * Picks a driver from the environment.
 *
 * `QUEUE_DRIVER=memory` runs the entire pipeline in one process with no Redis,
 * which is what makes the reference demo and CI runnable anywhere. Production
 * uses `bullmq` for durability and multi-process fan-out.
 */
export function createQueueDriver(env: NodeJS.ProcessEnv = process.env): QueueDriver {
  const kind = (env["QUEUE_DRIVER"] ?? "bullmq").toLowerCase();

  if (kind === "memory") return new MemoryQueueDriver();
  if (kind !== "bullmq") {
    throw new Error(`Unknown QUEUE_DRIVER "${kind}". Expected "bullmq" or "memory".`);
  }

  const redisUrl = env["REDIS_URL"];
  if (!redisUrl) {
    throw new Error(
      'QUEUE_DRIVER=bullmq requires REDIS_URL. Run `npm run infra:up`, or set QUEUE_DRIVER=memory for a single-process run.',
    );
  }
  return new BullMQDriver({ redisUrl, prefix: env["QUEUE_PREFIX"] ?? "averis" });
}
