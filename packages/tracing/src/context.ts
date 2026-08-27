import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * One position in a trace, in the terms the W3C `traceparent` header defines.
 *
 * These are the only three fields that cross a process boundary. Everything
 * else a span carries — its name, timings, attributes — stays on the side that
 * recorded it and is stitched back together by the collector, which is what
 * makes the wire format this small.
 */
export interface TraceContext {
  /** 32 lowercase hex characters, stable for the whole trace. */
  traceId: string;
  /** 16 lowercase hex characters, identifying one span within it. */
  spanId: string;
  /** The sampled flag. An unsampled context still propagates. */
  sampled: boolean;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

/**
 * Parses a `traceparent` header.
 *
 * Only version `00` is accepted, and the all-zero trace and span ids the spec
 * calls invalid are rejected rather than propagated — a trace rooted on them
 * cannot be joined to anything, so continuing one is worse than starting a
 * fresh trace with a real id.
 */
export function parseTraceparent(header: string | undefined | null): TraceContext | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!match) return undefined;

  const [, traceId, spanId, flags] = match as unknown as [string, string, string, string];
  if (traceId === INVALID_TRACE_ID || spanId === INVALID_SPAN_ID) return undefined;

  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01 };
}

/** Renders a context as a `traceparent` header value. */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? "01" : "00"}`;
}

export const newTraceId = (): string => randomBytes(16).toString("hex");
export const newSpanId = (): string => randomBytes(8).toString("hex");

/**
 * The ambient trace context.
 *
 * `AsyncLocalStorage` rather than an argument threaded through every call
 * because the alternative is to change the signature of everything between an
 * HTTP handler and a database call. The cost is that context is lost across a
 * boundary the runtime cannot see through — which is exactly what the queue
 * drivers restore explicitly.
 */
const storage = new AsyncLocalStorage<TraceContext>();

export function currentContext(): TraceContext | undefined {
  return storage.getStore();
}

/** The active context as a `traceparent`, for putting on the wire. */
export function currentTraceparent(): string | undefined {
  const context = currentContext();
  return context ? formatTraceparent(context) : undefined;
}

export function withContext<T>(context: TraceContext | undefined, run: () => T): T {
  return context ? storage.run(context, run) : run();
}
