/** Queues the protocol uses. One per lifecycle stage. */
export const QUEUES = {
  job: "job",
  evaluation: "evaluation",
  consensus: "consensus",
  resolution: "resolution",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface EnqueueOptions {
  /** Delay in milliseconds before the job becomes available. */
  delayMs?: number;
  /** Attempts including the first. Defaults to 3. */
  attempts?: number;
  /** Deduplication key — a repeat enqueue with the same id is dropped. */
  jobId?: string;
  backoffMs?: number;
}

export interface QueueMessage<T = unknown> {
  id: string;
  name: string;
  payload: T;
  attempt: number;
  /**
   * W3C `traceparent` of the enqueue, when the producer was being traced.
   *
   * Drivers capture this at `enqueue` and restore it around the handler, so a
   * consumer span attaches to the request that queued the work rather than
   * starting a trace of its own.
   */
  traceparent?: string | undefined;
}

export type MessageHandler<T = unknown> = (message: QueueMessage<T>) => Promise<void>;

export interface ProcessOptions {
  concurrency?: number;
  onFailed?: (message: QueueMessage, error: Error) => void | Promise<void>;
}

export interface Subscription {
  close(): Promise<void>;
}

/**
 * The protocol's only view of a queue.
 *
 * Workers and the API depend on this, never on BullMQ directly, so the whole
 * pipeline runs without Redis in tests and local development — and so the
 * transport can be replaced without touching lifecycle logic.
 */
export interface QueueDriver {
  readonly name: string;
  enqueue<T>(queue: QueueName, name: string, payload: T, options?: EnqueueOptions): Promise<string>;
  process<T>(queue: QueueName, handler: MessageHandler<T>, options?: ProcessOptions): Subscription;
  /** Approximate depth, for health reporting. */
  depth(queue: QueueName): Promise<number>;
  close(): Promise<void>;
}

/**
 * Normalizes a deduplication key to characters every driver accepts.
 *
 * BullMQ rejects `:` in a custom job id; the in-process driver does not care.
 * Normalizing in one place keeps the two drivers behaviourally identical —
 * otherwise code that works against the memory driver in tests fails against
 * Redis in production, which is the one thing this abstraction exists to
 * prevent.
 */
export function normalizeJobId(jobId: string): string {
  return jobId.replace(/[^A-Za-z0-9_-]/g, "-");
}
