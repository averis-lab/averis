import {
  normalizeJobId,
  type EnqueueOptions,
  type MessageHandler,
  type ProcessOptions,
  type QueueDriver,
  type QueueMessage,
  type QueueName,
  type Subscription,
} from "./types";

interface Pending {
  message: QueueMessage;
  attempts: number;
  backoffMs: number;
}

/**
 * In-process driver.
 *
 * Not a no-op stub — it implements retries, backoff, delays, concurrency
 * limits and deduplication, so worker logic exercised against it behaves the
 * same as against Redis. That is what lets the whole lifecycle be tested
 * without infrastructure.
 *
 * It is not durable: a crash loses queued work. Production uses BullMQ.
 */
export class MemoryQueueDriver implements QueueDriver {
  readonly name = "memory";

  private readonly queues = new Map<QueueName, Pending[]>();
  private readonly handlers = new Map<QueueName, { handler: MessageHandler; options: ProcessOptions }>();
  private readonly seenIds = new Set<string>();
  private readonly inFlight = new Map<QueueName, number>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private counter = 0;
  private closed = false;

  async enqueue<T>(
    queue: QueueName,
    name: string,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (this.closed) throw new Error("queue driver is closed");

    // Normalized identically to the BullMQ driver, so a dedup key that works
    // here behaves the same against Redis.
    const dedupeId = options.jobId ? normalizeJobId(options.jobId) : undefined;
    const id = dedupeId ?? `${queue}-${++this.counter}`;
    if (dedupeId && this.seenIds.has(dedupeId)) return dedupeId;
    if (dedupeId) this.seenIds.add(dedupeId);

    const pending: Pending = {
      message: { id, name, payload, attempt: 1 },
      attempts: options.attempts ?? 3,
      backoffMs: options.backoffMs ?? 250,
    };

    const push = () => {
      const list = this.queues.get(queue) ?? [];
      list.push(pending);
      this.queues.set(queue, list);
      this.drain(queue);
    };

    if (options.delayMs && options.delayMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        push();
      }, options.delayMs);
      this.timers.add(timer);
    } else {
      push();
    }

    return id;
  }

  process<T>(
    queue: QueueName,
    handler: MessageHandler<T>,
    options: ProcessOptions = {},
  ): Subscription {
    this.handlers.set(queue, {
      handler: handler as MessageHandler,
      options,
    });
    this.drain(queue);

    return {
      close: async () => {
        this.handlers.delete(queue);
      },
    };
  }

  async depth(queue: QueueName): Promise<number> {
    return this.queues.get(queue)?.length ?? 0;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.handlers.clear();
    this.queues.clear();
  }

  /** Resolves once every queue is empty and nothing is in flight. */
  async drained(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const queued = [...this.queues.values()].reduce((acc, list) => acc + list.length, 0);
      const running = [...this.inFlight.values()].reduce((acc, n) => acc + n, 0);
      if (queued === 0 && running === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("queue did not drain within the timeout");
  }

  private drain(queue: QueueName): void {
    const registration = this.handlers.get(queue);
    if (!registration || this.closed) return;

    const concurrency = registration.options.concurrency ?? 1;
    const list = this.queues.get(queue);
    if (!list || list.length === 0) return;

    while ((this.inFlight.get(queue) ?? 0) < concurrency) {
      const pending = list.shift();
      if (!pending) break;

      this.inFlight.set(queue, (this.inFlight.get(queue) ?? 0) + 1);

      void (async () => {
        try {
          await registration.handler(pending.message);
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));

          if (pending.message.attempt < pending.attempts) {
            const retry: Pending = {
              ...pending,
              message: { ...pending.message, attempt: pending.message.attempt + 1 },
            };
            const timer = setTimeout(
              () => {
                this.timers.delete(timer);
                const target = this.queues.get(queue) ?? [];
                target.push(retry);
                this.queues.set(queue, target);
                this.drain(queue);
              },
              pending.backoffMs * pending.message.attempt,
            );
            this.timers.add(timer);
          } else {
            await registration.options.onFailed?.(pending.message, err);
          }
        } finally {
          this.inFlight.set(queue, Math.max(0, (this.inFlight.get(queue) ?? 1) - 1));
          this.drain(queue);
        }
      })();
    }
  }
}
