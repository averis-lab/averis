import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disconnect } from "@averis/db";
import { MemoryExporter, Tracer, parseTraceparent } from "@averis/tracing";
import { buildServer } from "../../apps/api/src/server";
import { resetDatabase, seedRegistry, startPipeline, type Harness } from "./harness";

/**
 * One trace, from the HTTP request through every worker that request sets off.
 *
 * The unit tests prove each hop in isolation against an in-process queue. This
 * is the whole path against the real gateway and the real lifecycle, and it is
 * the only thing that can show the context actually survives all four stages
 * rather than the two a focused test happened to exercise.
 */

const KEY = "tracing-integration-key";
const INBOUND = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let harness: Harness;
let app: FastifyInstance;
const exporter = new MemoryExporter();

beforeAll(async () => {
  await resetDatabase();
  await seedRegistry([
    { name: "Markets Agent", domains: ["markets"] },
    { name: "Research Agent", domains: ["research", "markets"] },
  ]);

  harness = startPipeline({
    env: { ...process.env, API_KEYS: KEY },
    tracer: new Tracer({ serviceName: "averis-test", exporter }),
  });
  app = await buildServer({ ctx: harness.ctx });
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.stop();
  await disconnect();
});

describe("gateway spans", () => {
  it("continues a trace the caller started, and says so on the response", async () => {
    exporter.reset();

    const response = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { "x-api-key": KEY, traceparent: INBOUND },
    });

    expect(response.statusCode).toBe(200);

    const returned = parseTraceparent(response.headers["traceparent"] as string);
    expect(returned?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");

    const span = exporter.spans.find((s) => s.name === "GET /v1/agents")!;
    expect(span).toBeDefined();
    expect(span.kind).toBe("server");
    expect(span.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(span.parentSpanId).toBe("00f067aa0ba902b7");
    expect(span.attributes["http.response.status_code"]).toBe(200);
  });

  it("starts its own trace when the caller sends none", async () => {
    exporter.reset();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    const span = exporter.spans.find((s) => s.name === "GET /health")!;
    expect(span.parentSpanId).toBeUndefined();
    expect(parseTraceparent(response.headers["traceparent"] as string)?.traceId).toBe(
      span.traceId,
    );
  });

  it("keeps the query string out of the span name", async () => {
    exporter.reset();

    await app.inject({
      method: "GET",
      url: "/v1/jobs?limit=1",
      headers: { "x-api-key": KEY },
    });

    expect(exporter.spans.map((s) => s.name)).toContain("GET /v1/jobs");
  });

  it("marks a failed request as an error rather than merely slow", async () => {
    exporter.reset();

    const response = await app.inject({
      method: "GET",
      url: "/v1/agents",
      headers: { "x-api-key": "wrong-key" },
    });

    expect(response.statusCode).toBe(401);
    const span = exporter.spans.find((s) => s.name === "GET /v1/agents")!;
    // A rejected caller is a request handled correctly, not a server failure.
    expect(span.status).toBe("ok");
    expect(span.attributes["http.response.status_code"]).toBe(401);
  });
});

describe("the whole path", () => {
  it("puts the gateway and every worker stage in one trace", async () => {
    exporter.reset();

    const created = await app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { "x-api-key": KEY, traceparent: INBOUND },
      payload: {
        query: "What is the current state of market liquidity?",
        capabilities: ["markets"],
        maxAgents: 2,
      },
    });

    expect(created.statusCode).toBe(201);
    const jobId = created.json().data.id as string;

    // Wait for the lifecycle rather than for the queue: the resolution stage
    // is reached through three earlier hops, each of which enqueues the next.
    await vi.waitFor(
      () => {
        const names = exporter.spans.map((s) => s.name);
        expect(names).toContain("consensus receive");
      },
      { timeout: 45_000, interval: 250 },
    );

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const inTrace = exporter.spans.filter((s) => s.traceId === traceId);
    const names = inTrace.map((s) => s.name);

    expect(names).toContain("POST /v1/jobs");
    expect(names).toContain("job receive");
    expect(names).toContain("evaluation receive");
    expect(names).toContain("consensus receive");

    // Every worker span carries the job it was working on, which is what makes
    // a trace searchable by the identifier a user actually has.
    const jobSpan = inTrace.find((s) => s.name === "job receive")!;
    expect(jobSpan.attributes["averis.job.id"]).toBe(jobId);
    expect(jobSpan.kind).toBe("consumer");

    // And the chain is a chain: the first worker hangs off the request.
    const request = inTrace.find((s) => s.name === "POST /v1/jobs")!;
    expect(jobSpan.parentSpanId).toBe(request.spanId);
  }, 60_000);
});

/**
 * The BullMQ path, against a real Redis.
 *
 * BullMQ gives a job no metadata slot of its own, so the context has to ride
 * inside the job data — the one driver where propagation changes what goes
 * onto the wire. That makes it the one most worth running for real rather
 * than against a fake.
 */
describe("bullmq propagation", () => {
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

  it("joins the worker to the trace that enqueued the work", async () => {
    const { BullMQDriver } = await import("@averis/queue");
    const local = new MemoryExporter();
    const tracer = new Tracer({ serviceName: "bullmq-test", exporter: local });

    // A prefix of its own, so a developer's real queues are never touched.
    const driver = new BullMQDriver({ redisUrl, prefix: `averis-test-${Date.now()}` });

    let received: string | undefined;
    let payload: unknown;
    const subscription = driver.process<{ jobId: string }>("job", async (message) => {
      received = message.traceparent;
      payload = message.payload;
      await tracer.withSpan("job receive", async () => {}, { kind: "consumer" });
    });

    try {
      await tracer.withSpan("POST /v1/jobs", async () => {
        await driver.enqueue("job", "run", { jobId: "bullmq-1" });
      });

      await vi.waitFor(() => expect(received).toBeDefined(), { timeout: 15_000, interval: 100 });

      // Unwrapped on the way out: the handler sees its payload, not an envelope.
      expect(payload).toEqual({ jobId: "bullmq-1" });

      const request = local.spans.find((s) => s.name === "POST /v1/jobs")!;
      const worker = local.spans.find((s) => s.name === "job receive")!;
      expect(worker.traceId).toBe(request.traceId);
      expect(worker.parentSpanId).toBe(request.spanId);
    } finally {
      await subscription.close();
      await driver.close();
    }
  }, 30_000);
});
