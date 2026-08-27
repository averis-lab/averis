import type { FinishedSpan, SpanExporter } from "./span";

/**
 * Records nothing.
 *
 * The default, and the reason tracing costs effectively nothing when it is
 * switched off: spans are still created and still propagate — so a request
 * that crosses into a traced service keeps its ids — but nothing is retained
 * or sent anywhere.
 */
export class NoopExporter implements SpanExporter {
  readonly name = "none";
  export(): void {}
  async flush(): Promise<void> {}
}

/** Prints one line per span. For local runs, where a collector is overkill. */
export class ConsoleExporter implements SpanExporter {
  readonly name = "console";

  constructor(private readonly write: (line: string) => void = console.log) {}

  export(span: FinishedSpan): void {
    const parent = span.parentSpanId ? ` parent=${span.parentSpanId}` : "";
    const failed = span.status === "error" ? ` error="${span.error ?? ""}"` : "";
    this.write(
      `[trace] ${span.traceId} ${span.spanId}${parent} ${span.kind} ${span.name} ` +
        `${span.durationMs}ms${failed}`,
    );
  }

  async flush(): Promise<void> {}
}

/** Retains spans in memory. For tests and for asserting on propagation. */
export class MemoryExporter implements SpanExporter {
  readonly name = "memory";
  readonly spans: FinishedSpan[] = [];

  export(span: FinishedSpan): void {
    this.spans.push(span);
  }

  async flush(): Promise<void> {}

  reset(): void {
    this.spans.length = 0;
  }
}

export interface OtlpExporterConfig {
  /** Collector base URL, e.g. `http://localhost:4318`. */
  endpoint: string;
  serviceName: string;
  headers?: Record<string, string>;
  /** Spans buffered before a flush is triggered. */
  batchSize?: number;
  /** Longest a span waits in the buffer before being sent. */
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
  onError?: (error: Error) => void;
}

/**
 * Sends spans to an OTLP/HTTP collector as JSON.
 *
 * OTLP over HTTP with a JSON body is a documented wire format, so this reaches
 * Jaeger, Grafana Tempo, Honeycomb and anything else that speaks it without
 * the OpenTelemetry SDK in the dependency tree. That trade is deliberate: the
 * hop this project actually needs stitched is the queue, and no SDK
 * auto-instruments that — it has to be threaded by hand either way, which is
 * what `packages/queue` now does.
 *
 * Export is fire-and-forget by design. A collector being down is not a reason
 * for a job to fail, so a failed send is reported through `onError` and the
 * batch is dropped rather than retried into a growing buffer.
 */
export class OtlpHttpExporter implements SpanExporter {
  readonly name = "otlp";

  private readonly url: string;
  private readonly serviceName: string;
  private readonly headers: Record<string, string>;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (error: Error) => void;

  private buffer: FinishedSpan[] = [];
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(config: OtlpExporterConfig) {
    this.url = `${config.endpoint.replace(/\/+$/, "")}/v1/traces`;
    this.serviceName = config.serviceName;
    this.headers = config.headers ?? {};
    this.batchSize = config.batchSize ?? 128;
    this.flushIntervalMs = config.flushIntervalMs ?? 5_000;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.onError =
      config.onError ??
      ((error) => {
        console.warn("[trace] export failed:", error.message);
      });
  }

  export(span: FinishedSpan): void {
    // An unsampled span propagates but is never sent: that is what the flag is
    // for, and buffering it would spend memory to no end.
    if (!span.sampled) return;

    this.buffer.push(span);
    if (this.buffer.length >= this.batchSize) {
      void this.flush();
      return;
    }

    // `unref` so a pending flush never holds a short-lived process open.
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.length === 0) return this.inFlight;

    const batch = this.buffer;
    this.buffer = [];

    this.inFlight = this.send(batch).catch((error: unknown) => {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return this.inFlight;
  }

  private async send(batch: FinishedSpan[]): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(this.encode(batch)),
    });
    if (!response.ok) {
      throw new Error(`collector returned ${response.status}`);
    }
  }

  /** The OTLP `ExportTraceServiceRequest` shape. */
  private encode(batch: FinishedSpan[]) {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: this.serviceName } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "@averis/tracing" },
              spans: batch.map((span) => ({
                traceId: span.traceId,
                spanId: span.spanId,
                ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                name: span.name,
                kind: OTLP_KIND[span.kind],
                // OTLP counts in nanoseconds since the epoch, as a string:
                // the values overflow a float64's integer range.
                startTimeUnixNano: String(span.startTime * 1_000_000),
                endTimeUnixNano: String(span.endTime * 1_000_000),
                attributes: Object.entries(span.attributes).map(([key, value]) => ({
                  key,
                  value: otlpValue(value),
                })),
                status:
                  span.status === "error"
                    ? { code: 2, message: span.error ?? "" }
                    : { code: 1 },
              })),
            },
          ],
        },
      ],
    };
  }
}

/** OTLP `SpanKind` enum values. */
const OTLP_KIND: Record<FinishedSpan["kind"], number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

function otlpValue(value: string | number | boolean) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}
