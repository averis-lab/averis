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

/**
 * Runs one parameterised statement and returns its rows.
 *
 * Injected rather than imported, and for a specific reason:
 * `packages/db/src/client.ts` builds its Prisma client at module scope and
 * throws when DATABASE_URL is absent. A static `import { prisma }` here would
 * travel through `index.ts` into every consumer of this package, and the
 * memory driver — the one that exists so the pipeline runs with no
 * infrastructure at all — would stop working in tests that have no database.
 * So the real executor is resolved lazily, on first use, only when this driver
 * is the one that was selected.
 */
export type SqlExecutor = (sql: string, ...params: unknown[]) => Promise<unknown[]>;

export interface PgmqConfig {
  /** Overrides the lazily-resolved Prisma executor. For tests. */
  sql?: SqlExecutor;
  /**
   * Seconds a message stays invisible to other consumers after being read.
   *
   * This is the deadline for the handler, not a tuning knob: a job still
   * running when the timeout expires is handed to a second consumer while the
   * first is mid-flight. It must exceed the slowest handler — agent jobs run
   * for tens of seconds — which is why the default is minutes, not seconds.
   */
  visibilityTimeoutSec?: number;
  /** Idle gap between polls, in milliseconds. */
  pollIntervalMs?: number;
  /** Reports a failure of the poll loop itself, as opposed to of a message. */
  onError?: (error: Error) => void;
}

/**
 * What actually goes into the pgmq message body.
 *
 * pgmq stores an opaque jsonb and knows nothing about retry policy, so the
 * policy travels with the message. The alternative — keeping it consumer-side
 * — would mean a message enqueued with `attempts: 5` is retried three times
 * because that is what the consumer happened to be configured with.
 */
interface Envelope<T = unknown> {
  name: string;
  payload: T;
  attempts: number;
  backoffMs: number;
  dedupeId?: string;
}

interface ReadRow {
  msg_id: bigint | number | string;
  read_ct: number;
  message: Envelope;
}

/**
 * Durable, multi-process driver backed by Postgres — no Redis.
 *
 * pgmq is a queue implemented as a Postgres extension, and Supabase ships it,
 * so the queue lives in the database the application already has. Two things
 * fall out of that which Redis does not give for free:
 *
 *  * Delivery is at-least-once by construction. A read makes a message
 *    invisible for `visibilityTimeoutSec` rather than removing it, so a
 *    consumer that dies mid-job does not take the job with it — the message
 *    simply becomes visible again. BullMQ needs a stalled-job checker for the
 *    same guarantee.
 *  * There is no separate service to pay for, secure or keep alive.
 *
 * The cost is that there is no blocking read. `pgmq.read_with_poll` exists,
 * but it holds its connection for the whole wait, and on a transaction-mode
 * pooler that spends the connection budget the API also needs. Short polling
 * spends a query instead, which is the cheaper of the two here.
 */
export class PgmqDriver implements QueueDriver {
  readonly name = "pgmq";

  private readonly configuredSql: SqlExecutor | undefined;
  private readonly visibilityTimeoutSec: number;
  private readonly pollIntervalMs: number;
  private readonly onError: (error: Error) => void;
  private sqlPromise: Promise<SqlExecutor> | undefined;
  private readonly stops = new Set<() => void>();
  private closed = false;

  constructor(config: PgmqConfig = {}) {
    this.configuredSql = config.sql;
    this.visibilityTimeoutSec = config.visibilityTimeoutSec ?? 300;
    this.pollIntervalMs = config.pollIntervalMs ?? 1_000;
    this.onError =
      config.onError ??
      ((error) => {
        console.error("[pgmq] poll failed:", error.message);
      });
  }

  private sql(): Promise<SqlExecutor> {
    if (this.configuredSql) return Promise.resolve(this.configuredSql);
    this.sqlPromise ??= import("@averis/db").then(({ prisma }): SqlExecutor => {
      return (text, ...params) =>
        prisma.$queryRawUnsafe(text, ...params) as unknown as Promise<unknown[]>;
    });
    return this.sqlPromise;
  }

  async enqueue<T>(
    queue: QueueName,
    name: string,
    payload: T,
    options: EnqueueOptions = {},
  ): Promise<string> {
    if (this.closed) throw new Error("queue driver is closed");
    const run = await this.sql();

    const dedupeId = options.jobId ? normalizeJobId(options.jobId) : undefined;
    if (dedupeId) {
      // pgmq has no counterpart to BullMQ's "a jobId that already exists is
      // silently ignored", and the lifecycle depends on that to stay
      // idempotent under at-least-once delivery. A unique key plus
      // ON CONFLICT DO NOTHING reproduces it — and unlike the memory driver's
      // in-process Set, it survives a restart.
      const claimed = await run(
        `INSERT INTO queue_dedupe (id, queue) VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        dedupeId,
        queue,
      );
      if (claimed.length === 0) return dedupeId;
    }

    const envelope: Envelope<T> = {
      name,
      payload,
      attempts: options.attempts ?? 3,
      backoffMs: options.backoffMs ?? 250,
      ...(dedupeId ? { dedupeId } : {}),
    };

    // pgmq counts delay in whole seconds. Rounding up rather than down: a
    // message delivered later than asked is a slower retry, one delivered
    // earlier is a retry that skips its own backoff.
    const delaySec =
      options.delayMs && options.delayMs > 0 ? Math.ceil(options.delayMs / 1_000) : 0;

    const rows = (await run(
      `SELECT pgmq.send($1, $2::jsonb, $3::int) AS msg_id`,
      queue,
      JSON.stringify(envelope),
      delaySec,
    )) as { msg_id: bigint | number | string }[];

    return dedupeId ?? `${queue}-${String(rows[0]?.msg_id ?? "")}`;
  }

  process<T>(
    queue: QueueName,
    handler: MessageHandler<T>,
    options: ProcessOptions = {},
  ): Subscription {
    const concurrency = options.concurrency ?? 1;
    let stopped = false;
    let inFlight = 0;

    const loop = async (): Promise<void> => {
      while (!stopped && !this.closed) {
        let picked = 0;
        try {
          const capacity = concurrency - inFlight;
          if (capacity > 0) {
            const run = await this.sql();
            // `conditional` is passed explicitly rather than relying on its
            // default, so the overload resolves the same way on every pgmq
            // version that has ever shipped this function.
            const rows = (await run(
              `SELECT msg_id, read_ct, message
                 FROM pgmq.read($1, $2::int, $3::int, '{}'::jsonb)`,
              queue,
              this.visibilityTimeoutSec,
              capacity,
            )) as ReadRow[];

            picked = rows.length;
            for (const row of rows) {
              inFlight += 1;
              void this.dispatch(queue, row, handler as MessageHandler, options).finally(() => {
                inFlight -= 1;
              });
            }
          }
        } catch (error) {
          // A database blip must not turn into a hot loop hammering it.
          this.onError(error instanceof Error ? error : new Error(String(error)));
          await sleep(this.pollIntervalMs);
          continue;
        }

        // Only back off when the queue was empty. A batch that filled the
        // capacity is a sign there is more waiting, so go straight round again.
        if (picked === 0) await sleep(this.pollIntervalMs);
      }
    };

    const stop = (): void => {
      stopped = true;
    };
    this.stops.add(stop);
    void loop();

    return {
      close: async () => {
        stop();
        this.stops.delete(stop);
      },
    };
  }

  private async dispatch(
    queue: QueueName,
    row: ReadRow,
    handler: MessageHandler,
    options: ProcessOptions,
  ): Promise<void> {
    const run = await this.sql();
    const msgId = String(row.msg_id);
    const envelope = row.message;
    const message: QueueMessage = {
      id: envelope.dedupeId ?? `${queue}-${msgId}`,
      name: envelope.name,
      payload: envelope.payload,
      // pgmq counts reads, and the first read is 1 — the same base the memory
      // and BullMQ drivers report.
      attempt: row.read_ct,
    };

    try {
      await handler(message);
      await run(`SELECT pgmq."delete"($1, $2::bigint)`, queue, msgId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      try {
        if (row.read_ct < envelope.attempts) {
          // Shorten the invisibility to the backoff. Doing nothing would also
          // retry, but only after the full visibility timeout — minutes, for
          // what the caller asked to be milliseconds.
          const backoffSec = Math.max(
            1,
            Math.ceil((envelope.backoffMs * row.read_ct) / 1_000),
          );
          await run(`SELECT pgmq.set_vt($1, $2::bigint, $3::int)`, queue, msgId, backoffSec);
        } else {
          await options.onFailed?.(message, err);
          // Archived rather than deleted: a message that exhausted its
          // attempts is precisely the one somebody will want to read later.
          await run(`SELECT pgmq.archive($1, $2::bigint)`, queue, msgId);
        }
      } catch (bookkeeping) {
        this.onError(
          bookkeeping instanceof Error ? bookkeeping : new Error(String(bookkeeping)),
        );
      }
    }
  }

  async depth(queue: QueueName): Promise<number> {
    const run = await this.sql();
    const rows = (await run(
      `SELECT queue_length FROM pgmq.metrics($1)`,
      queue,
    )) as { queue_length: bigint | number | null }[];
    return Number(rows[0]?.queue_length ?? 0);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stop of this.stops) stop();
    this.stops.clear();
    // The Prisma client is deliberately left alone: it is shared with the rest
    // of the process, and `disconnect()` is the application's call to make.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
