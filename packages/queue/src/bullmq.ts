import { Queue, Worker, type ConnectionOptions } from "bullmq";
import {
  normalizeJobId,
  type EnqueueOptions,
  type MessageHandler,
  type ProcessOptions,
  type QueueDriver,
  type QueueName,
  type Subscription,
} from "./types";
import { captureTraceparent, packTrace, unpackTrace } from "./trace";
import { parseTraceparent, withContext } from "@averis/tracing";

export interface BullMQConfig {
  redisUrl: string;
  prefix?: string;
  /** Completed/failed jobs retained, for post-mortem inspection. */
  keepCompleted?: number;
  keepFailed?: number;
}

/** Durable, multi-process driver backed by Redis. */
export class BullMQDriver implements QueueDriver {
  readonly name = "bullmq";

  private readonly connection: ConnectionOptions;
  private readonly prefix: string;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers = new Set<Worker>();
  private readonly keepCompleted: number;
  private readonly keepFailed: number;

  constructor(config: BullMQConfig) {
    const url = new URL(config.redisUrl);
    // Percent-decode: a password containing @ or / has to be encoded in the
    // URL, and ioredis wants the literal.
    const password = decodeURIComponent(url.password);
    const username = decodeURIComponent(url.username);
    // `/2` selects database 2. Managed providers hand out a bare host and
    // ignore this; a local instance does not.
    const db = Number(url.pathname.slice(1));
    this.connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(password ? { password } : {}),
      ...(username ? { username } : {}),
      ...(Number.isInteger(db) && db > 0 ? { db } : {}),
      /**
       * `rediss://` is TLS. Every managed provider — Upstash, Redis Cloud,
       * Aiven — serves only that scheme, and ioredis does not infer it from
       * the URL when the connection is assembled field by field as it is
       * here: without this the handshake fails with a bare ECONNRESET, which
       * reads like a network fault rather than a missing option.
       *
       * `servername` is what makes SNI work, and the managed providers put
       * many tenants behind one address, so a TLS session opened without it
       * is offered the wrong certificate.
       */
      ...(url.protocol === "rediss:" ? { tls: { servername: url.hostname } } : {}),
      // BullMQ requires this; without it blocking commands fail on reconnect.
      maxRetriesPerRequest: null,
    };
    this.prefix = config.prefix ?? "averis";
    this.keepCompleted = config.keepCompleted ?? 500;
    this.keepFailed = config.keepFailed ?? 2_000;
  }

  private queue(name: QueueName): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const queue = new Queue(name, { connection: this.connection, prefix: this.prefix });
    this.queues.set(name, queue);
    return queue;
  }

  async enqueue<T>(
    queue: QueueName,
    name: string,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<string> {
    // Redis job data is the only field of a BullMQ job this driver controls,
    // so the trace context travels inside it — and only when there is one, so
    // an untraced deployment writes exactly the bytes it wrote before.
    const data = packTrace(payload, captureTraceparent());

    const job = await this.queue(queue).add(name, data, {
      attempts: options.attempts ?? 3,
      backoff: { type: "exponential", delay: options.backoffMs ?? 1_000 },
      removeOnComplete: this.keepCompleted,
      removeOnFail: this.keepFailed,
      ...(options.delayMs ? { delay: options.delayMs } : {}),
      // A jobId that already exists is silently ignored by BullMQ, which is
      // the deduplication the lifecycle relies on for at-least-once delivery.
      ...(options.jobId ? { jobId: normalizeJobId(options.jobId) } : {}),
    });
    return String(job.id);
  }

  process<T>(
    queue: QueueName,
    handler: MessageHandler<T>,
    options: ProcessOptions = {},
  ): Subscription {
    const worker = new Worker(
      queue,
      async (job) => {
        const { payload, traceparent } = unpackTrace(job.data);
        await withContext(parseTraceparent(traceparent), () =>
          handler({
            id: String(job.id),
            name: job.name,
            payload: payload as T,
            attempt: job.attemptsMade + 1,
            traceparent,
          }),
        );
      },
      {
        connection: this.connection,
        prefix: this.prefix,
        concurrency: options.concurrency ?? 1,
      },
    );

    if (options.onFailed) {
      worker.on("failed", (job, error) => {
        if (!job) return;
        const { payload, traceparent } = unpackTrace(job.data);
        void options.onFailed?.(
          {
            id: String(job.id),
            name: job.name,
            payload,
            attempt: job.attemptsMade,
            traceparent,
          },
          error,
        );
      });
    }

    this.workers.add(worker);

    return {
      close: async () => {
        this.workers.delete(worker);
        await worker.close();
      },
    };
  }

  async depth(queue: QueueName): Promise<number> {
    const counts = await this.queue(queue).getJobCounts("waiting", "active", "delayed");
    return (counts["waiting"] ?? 0) + (counts["active"] ?? 0) + (counts["delayed"] ?? 0);
  }

  async close(): Promise<void> {
    await Promise.all([...this.workers].map((w) => w.close()));
    this.workers.clear();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
