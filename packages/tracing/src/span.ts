import type { TraceContext } from "./context";

export type SpanKind = "server" | "client" | "producer" | "consumer" | "internal";

export type AttributeValue = string | number | boolean;

/** A finished span, in the shape an exporter receives it. */
export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  name: string;
  kind: SpanKind;
  /** Epoch milliseconds. */
  startTime: number;
  endTime: number;
  durationMs: number;
  attributes: Record<string, AttributeValue>;
  status: "ok" | "error";
  /** Present only when the span failed. */
  error: string | undefined;
  sampled: boolean;
}

/**
 * A span in progress.
 *
 * `end` is idempotent: a span ended in a `finally` and again by an outer
 * helper must not export twice, and making the second call a no-op is cheaper
 * to reason about than making every caller prove it only ends once.
 */
export interface Span {
  readonly context: TraceContext;
  setAttribute(key: string, value: AttributeValue): void;
  setAttributes(attributes: Record<string, AttributeValue | undefined>): void;
  recordError(error: unknown): void;
  end(): void;
}

export interface SpanExporter {
  readonly name: string;
  export(span: FinishedSpan): void;
  /** Flushes anything buffered. Safe to call more than once. */
  flush(): Promise<void>;
}
