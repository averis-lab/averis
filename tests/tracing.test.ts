import { describe, expect, it, vi } from "vitest";
import {
  ConsoleExporter,
  MemoryExporter,
  NoopExporter,
  OtlpHttpExporter,
  Tracer,
  createTracer,
  currentTraceparent,
  formatTraceparent,
  parseTraceparent,
} from "@averis/tracing";
import {
  MemoryQueueDriver,
  PgmqDriver,
  QUEUES,
  packTrace,
  unpackTrace,
  type SqlExecutor,
} from "@averis/queue";

const VALID = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("W3C trace context", () => {
  it("round-trips a traceparent", () => {
    const parsed = parseTraceparent(VALID);
    expect(parsed).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      sampled: true,
    });
    expect(formatTraceparent(parsed!)).toBe(VALID);
  });

  it("reads the sampled flag rather than assuming it", () => {
    expect(parseTraceparent(VALID.replace(/-01$/, "-00"))?.sampled).toBe(false);
  });

  it("rejects a header it cannot join a trace with", () => {
    for (const header of [
      undefined,
      "",
      "garbage",
      // Version 01 is not something this parser can claim to understand.
      VALID.replace(/^00-/, "01-"),
      // The spec's invalid ids: propagating them roots a trace on nothing.
      `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`,
      // Wrong lengths.
      "00-4bf92f35-00f067aa0ba902b7-01",
    ]) {
      expect(parseTraceparent(header)).toBeUndefined();
    }
  });

  it("accepts an uppercase header, which the spec permits on the wire", () => {
    expect(parseTraceparent(VALID.toUpperCase())?.traceId).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });
});

describe("tracer", () => {
  const build = () => {
    const exporter = new MemoryExporter();
    return { exporter, tracer: new Tracer({ serviceName: "test", exporter }) };
  };

  it("continues an incoming trace instead of starting its own", async () => {
    const { exporter, tracer } = build();
    await tracer.withSpan("handle", async () => {}, { parent: VALID });

    expect(exporter.spans[0]!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(exporter.spans[0]!.parentSpanId).toBe("00f067aa0ba902b7");
  });

  it("nests a child span under the ambient one", async () => {
    const { exporter, tracer } = build();
    await tracer.withSpan("outer", async () => {
      await tracer.withSpan("inner", async () => {});
    });

    const inner = exporter.spans.find((s) => s.name === "inner")!;
    const outer = exporter.spans.find((s) => s.name === "outer")!;
    expect(inner.traceId).toBe(outer.traceId);
    expect(inner.parentSpanId).toBe(outer.spanId);
  });

  it("records a failure and still rethrows it", async () => {
    const { exporter, tracer } = build();
    await expect(
      tracer.withSpan("boom", async () => {
        throw new Error("upstream exploded");
      }),
    ).rejects.toThrow("upstream exploded");

    expect(exporter.spans[0]!.status).toBe("error");
    expect(exporter.spans[0]!.error).toBe("upstream exploded");
  });

  it("does not export the same span twice", () => {
    const { exporter, tracer } = build();
    const span = tracer.startSpan("once");
    span.end();
    span.end();
    expect(exporter.spans).toHaveLength(1);
  });

  it("inherits the sampling decision rather than re-rolling it per span", async () => {
    const exporter = new MemoryExporter();
    // Rate 0: nothing new would be sampled, but an inbound sampled trace is.
    const tracer = new Tracer({ serviceName: "test", exporter, sampleRate: 0 });

    await tracer.withSpan("child", async () => {}, { parent: VALID });
    expect(exporter.spans[0]!.sampled).toBe(true);

    await tracer.withSpan("root", async () => {});
    expect(exporter.spans[1]!.sampled).toBe(false);
  });

  it("starts a fresh trace when asked for a root", async () => {
    const { exporter, tracer } = build();
    await tracer.withSpan("outer", async () => {
      await tracer.withSpan("sweep", async () => {}, { root: true });
    });

    const sweep = exporter.spans.find((s) => s.name === "sweep")!;
    const outer = exporter.spans.find((s) => s.name === "outer")!;
    expect(sweep.parentSpanId).toBeUndefined();
    expect(sweep.traceId).not.toBe(outer.traceId);
  });
});

describe("configuration", () => {
  it("records nothing unless it is asked to", () => {
    expect(createTracer({}).exporter).toBeInstanceOf(NoopExporter);
    expect(createTracer({}).enabled).toBe(false);
  });

  it("treats an endpoint on its own as the intent it plainly is", () => {
    const tracer = createTracer({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" });
    expect(tracer.exporter).toBeInstanceOf(OtlpHttpExporter);
  });

  it("falls back to no-op when otlp is asked for without an endpoint", () => {
    expect(createTracer({ TRACING_EXPORTER: "otlp" }).exporter).toBeInstanceOf(NoopExporter);
  });

  it("supports the console exporter for local runs", () => {
    expect(createTracer({ TRACING_EXPORTER: "console" }).exporter).toBeInstanceOf(ConsoleExporter);
  });
});

describe("otlp export", () => {
  it("encodes a span into the OTLP request shape", async () => {
    let body: any;
    const exporter = new OtlpHttpExporter({
      endpoint: "http://collector:4318/",
      serviceName: "averis-api",
      batchSize: 1,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    const tracer = new Tracer({ serviceName: "averis-api", exporter });
    await tracer.withSpan("GET /v1/jobs", async (span) => {
      span.setAttribute("http.response.status_code", 200);
    });
    await exporter.flush();

    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe("GET /v1/jobs");
    expect(span.kind).toBe(1);
    expect(span.status.code).toBe(1);
    // Nanoseconds, as a string: the value overflows a float64's integer range.
    expect(typeof span.startTimeUnixNano).toBe("string");
    expect(body.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("averis-api");
    expect(span.attributes).toContainEqual({
      key: "http.response.status_code",
      value: { intValue: "200" },
    });
  });

  it("never lets a dead collector reach the caller", async () => {
    const errors: Error[] = [];
    const exporter = new OtlpHttpExporter({
      endpoint: "http://collector:4318",
      serviceName: "averis",
      batchSize: 1,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      onError: (error) => errors.push(error),
    });

    const tracer = new Tracer({ serviceName: "averis", exporter });
    await tracer.withSpan("work", async () => {});
    await exporter.flush();

    expect(errors.map((e) => e.message)).toEqual(["ECONNREFUSED"]);
  });

  it("buffers an unsampled span nowhere", async () => {
    let sent = 0;
    const exporter = new OtlpHttpExporter({
      endpoint: "http://collector:4318",
      serviceName: "averis",
      batchSize: 1,
      fetchImpl: (async () => {
        sent += 1;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    const tracer = new Tracer({ serviceName: "averis", exporter, sampleRate: 0 });
    await tracer.withSpan("unsampled", async () => {});
    await exporter.flush();

    expect(sent).toBe(0);
  });
});

describe("trace propagation across the queue", () => {
  it("leaves an untraced payload byte-for-byte unchanged", () => {
    const payload = { jobId: "job-1" };
    expect(packTrace(payload, undefined)).toBe(payload);
  });

  it("reads a payload that was enqueued before tracing existed", () => {
    expect(unpackTrace({ jobId: "job-1" })).toEqual({
      payload: { jobId: "job-1" },
      traceparent: undefined,
    });
  });

  it("round-trips a wrapped payload", () => {
    expect(unpackTrace(packTrace({ jobId: "job-1" }, VALID))).toEqual({
      payload: { jobId: "job-1" },
      traceparent: VALID,
    });
  });

  it("joins the worker to the trace that enqueued the work", async () => {
    const exporter = new MemoryExporter();
    const tracer = new Tracer({ serviceName: "test", exporter });
    const queue = new MemoryQueueDriver();

    let observed: string | undefined;
    queue.process<{ jobId: string }>(QUEUES.job, async (message) => {
      // The span a worker would open, and the context the driver restored.
      observed = message.traceparent;
      await tracer.withSpan("job receive", async () => {}, { kind: "consumer" });
    });

    // Stand in for the HTTP request that creates a job.
    await tracer.withSpan("POST /v1/jobs", async () => {
      await queue.enqueue(QUEUES.job, "run", { jobId: "job-1" });
    });
    await queue.drained();

    const request = exporter.spans.find((s) => s.name === "POST /v1/jobs")!;
    const worker = exporter.spans.find((s) => s.name === "job receive")!;

    expect(observed).toBeDefined();
    // The point of the whole exercise: one trace, not two.
    expect(worker.traceId).toBe(request.traceId);
    expect(worker.parentSpanId).toBe(request.spanId);
  });

  it("carries the context through a retry, where the async scope is gone", async () => {
    const exporter = new MemoryExporter();
    const tracer = new Tracer({ serviceName: "test", exporter });
    const queue = new MemoryQueueDriver();

    let attempts = 0;
    queue.process<{ jobId: string }>(
      QUEUES.job,
      async () => {
        attempts += 1;
        await tracer.withSpan("job receive", async () => {}, { kind: "consumer" });
        if (attempts === 1) throw new Error("transient");
      },
      { concurrency: 1 },
    );

    await tracer.withSpan("POST /v1/jobs", async () => {
      await queue.enqueue(QUEUES.job, "run", { jobId: "job-1" }, { backoffMs: 1 });
    });

    // Not `drained()`: the retry is scheduled on a timer, so there is a moment
    // where the queue is empty and nothing is in flight yet the work is not
    // finished. Wait for the attempt itself.
    await vi.waitFor(() => expect(attempts).toBe(2));

    const request = exporter.spans.find((s) => s.name === "POST /v1/jobs")!;
    const retries = exporter.spans.filter((s) => s.name === "job receive");
    expect(retries).toHaveLength(2);
    for (const span of retries) expect(span.traceId).toBe(request.traceId);
  });

  it("does not attach a worker to an unrelated trace when nothing enqueued it", async () => {
    const exporter = new MemoryExporter();
    const tracer = new Tracer({ serviceName: "test", exporter });
    const queue = new MemoryQueueDriver();

    queue.process<{ jobId: string }>(QUEUES.job, async () => {
      await tracer.withSpan("job receive", async () => {}, { kind: "consumer" });
    });

    // Enqueued with no active span, as the operator loop does.
    await queue.enqueue(QUEUES.job, "run", { jobId: "job-1" });
    await queue.drained();

    const worker = exporter.spans.find((s) => s.name === "job receive")!;
    expect(worker.parentSpanId).toBeUndefined();
  });

  it("exposes the active traceparent to whatever needs to put it on a wire", async () => {
    const tracer = new Tracer({ serviceName: "test", exporter: new MemoryExporter() });
    expect(currentTraceparent()).toBeUndefined();

    await tracer.withSpan("outer", async () => {
      expect(parseTraceparent(currentTraceparent())).toBeDefined();
    });
  });
});

/**
 * The pgmq path, with the SQL stubbed.
 *
 * pgmq is the production default, so leaving its propagation untested would
 * mean the one driver that actually runs is the one nothing exercised. The
 * extension is not in the local Postgres image, so the statements are faked —
 * but the part this change touches is real: the envelope is serialized to JSON
 * and parsed back exactly as jsonb would, and the context is restored from it.
 */
describe("pgmq propagation", () => {
  function fakePgmq() {
    const sent: { queue: string; body: string }[] = [];
    const deleted: string[] = [];

    const sql: SqlExecutor = async (text, ...params) => {
      if (text.includes("pgmq.send")) {
        sent.push({ queue: String(params[0]), body: String(params[1]) });
        return [{ msg_id: sent.length }];
      }
      if (text.includes("pgmq.read")) {
        const row = sent.shift();
        if (!row) return [];
        // jsonb comes back parsed, which is what the driver expects.
        return [{ msg_id: 1, read_ct: 1, message: JSON.parse(row.body) }];
      }
      if (text.includes('pgmq."delete"')) {
        deleted.push(String(params[1]));
        return [];
      }
      return [];
    };

    return { sql, sent, deleted };
  }

  it("writes the trace context into the message and restores it on read", async () => {
    const exporter = new MemoryExporter();
    const tracer = new Tracer({ serviceName: "test", exporter });
    const { sql } = fakePgmq();
    const driver = new PgmqDriver({ sql, pollIntervalMs: 5 });

    let received: string | undefined;
    const subscription = driver.process<{ jobId: string }>(QUEUES.job, async (message) => {
      received = message.traceparent;
      await tracer.withSpan("job receive", async () => {}, { kind: "consumer" });
    });

    await tracer.withSpan("POST /v1/jobs", async () => {
      await driver.enqueue(QUEUES.job, "run", { jobId: "job-1" });
    });

    await vi.waitFor(() => expect(received).toBeDefined());
    await subscription.close();
    await driver.close();

    const request = exporter.spans.find((s) => s.name === "POST /v1/jobs")!;
    const worker = exporter.spans.find((s) => s.name === "job receive")!;
    expect(worker.traceId).toBe(request.traceId);
    expect(worker.parentSpanId).toBe(request.spanId);
  });

  it("omits the field entirely when nothing is being traced", async () => {
    const { sql, sent } = fakePgmq();
    const driver = new PgmqDriver({ sql });

    await driver.enqueue(QUEUES.job, "run", { jobId: "job-1" });
    await driver.close();

    // Not merely absent from the type: absent from the bytes, so a queue
    // drained across a deploy sees exactly what it saw before.
    expect(JSON.parse(sent[0]!.body)).not.toHaveProperty("traceparent");
  });

  it("reads a message written before tracing existed", async () => {
    const legacy = { name: "run", payload: { jobId: "old" }, attempts: 3, backoffMs: 250 };
    const sql: SqlExecutor = async (text) => {
      if (text.includes("pgmq.read")) return [{ msg_id: 7, read_ct: 1, message: legacy }];
      return [];
    };

    const driver = new PgmqDriver({ sql, pollIntervalMs: 5 });
    let seen: { jobId: string } | undefined;
    const subscription = driver.process<{ jobId: string }>(QUEUES.job, async (message) => {
      seen = message.payload;
    });

    await vi.waitFor(() => expect(seen).toEqual({ jobId: "old" }));
    await subscription.close();
    await driver.close();
  });
});
