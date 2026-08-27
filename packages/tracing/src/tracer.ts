import {
  currentContext,
  newSpanId,
  newTraceId,
  parseTraceparent,
  withContext,
  type TraceContext,
} from "./context";
import type { AttributeValue, FinishedSpan, Span, SpanExporter, SpanKind } from "./span";
import { NoopExporter } from "./exporters";

export interface StartSpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, AttributeValue | undefined>;
  /**
   * Parent to attach to, overriding the ambient context. Given as a
   * `traceparent` because that is the form it arrives in from a header or a
   * queue message.
   */
  parent?: string | TraceContext | undefined;
  /** Starts a new trace even if one is active. */
  root?: boolean;
}

export interface TracerConfig {
  serviceName: string;
  exporter?: SpanExporter;
  /**
   * Fraction of *root* traces recorded, 0..1. A trace that arrives already
   * sampled stays sampled, and one that arrives unsampled stays unsampled —
   * the decision is made once, by whoever started the trace, so a single
   * request never lands half-recorded across services.
   */
  sampleRate?: number;
  now?: () => number;
}

/**
 * Creates spans and hands finished ones to an exporter.
 *
 * There is no global tracer to register: one is built at each composition root
 * and passed down, the same way the queue driver and the data provider are.
 */
export class Tracer {
  readonly serviceName: string;
  readonly exporter: SpanExporter;

  private readonly sampleRate: number;
  private readonly now: () => number;

  constructor(config: TracerConfig) {
    this.serviceName = config.serviceName;
    this.exporter = config.exporter ?? new NoopExporter();
    this.sampleRate = clamp01(config.sampleRate ?? 1);
    this.now = config.now ?? Date.now;
  }

  /** Whether anything is actually recorded, for cheap guards at call sites. */
  get enabled(): boolean {
    return this.exporter.name !== "none";
  }

  startSpan(name: string, options: StartSpanOptions = {}): Span {
    const parent = options.root ? undefined : resolveParent(options.parent);

    const context: TraceContext = {
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
      // Inherited, never re-rolled: re-deciding per span would produce traces
      // with holes in them, which are harder to read than no trace at all.
      sampled: parent ? parent.sampled : Math.random() < this.sampleRate,
    };

    const attributes: Record<string, AttributeValue> = {};
    for (const [key, value] of Object.entries(options.attributes ?? {})) {
      if (value !== undefined) attributes[key] = value;
    }

    const startTime = this.now();
    let ended = false;
    let status: FinishedSpan["status"] = "ok";
    let error: string | undefined;

    return {
      context,
      setAttribute: (key, value) => {
        attributes[key] = value;
      },
      setAttributes: (next) => {
        for (const [key, value] of Object.entries(next)) {
          if (value !== undefined) attributes[key] = value;
        }
      },
      recordError: (thrown) => {
        status = "error";
        error = thrown instanceof Error ? thrown.message : String(thrown);
      },
      end: () => {
        if (ended) return;
        ended = true;
        const endTime = this.now();
        this.exporter.export({
          traceId: context.traceId,
          spanId: context.spanId,
          parentSpanId: parent?.spanId,
          name,
          kind: options.kind ?? "internal",
          startTime,
          endTime,
          durationMs: endTime - startTime,
          attributes,
          status,
          error,
          sampled: context.sampled,
        });
      },
    };
  }

  /**
   * Runs `fn` with the span active, ending it however `fn` finishes.
   *
   * A thrown error is recorded on the span and rethrown — tracing observes,
   * it never swallows.
   */
  async withSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options: StartSpanOptions = {},
  ): Promise<T> {
    const span = this.startSpan(name, options);
    try {
      return await withContext(span.context, () => fn(span));
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }
}

function resolveParent(explicit: StartSpanOptions["parent"]): TraceContext | undefined {
  if (typeof explicit === "string") return parseTraceparent(explicit);
  if (explicit) return explicit;
  return currentContext();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}
