import { ConsoleExporter, NoopExporter, OtlpHttpExporter } from "./exporters";
import { Tracer } from "./tracer";
import type { SpanExporter } from "./span";

export * from "./context";
export * from "./span";
export * from "./exporters";
export { Tracer, type StartSpanOptions, type TracerConfig } from "./tracer";

/**
 * Builds the tracer from the environment.
 *
 * Off unless asked for. `TRACING_EXPORTER=otlp` with
 * `OTEL_EXPORTER_OTLP_ENDPOINT` set sends to a collector; `console` prints a
 * line per span; anything else, or nothing, records nothing at all.
 *
 * Setting the endpoint alone is enough — forgetting the second variable is the
 * obvious way to configure this wrongly, and it fails silently, so it is
 * treated as the intent it plainly is.
 */
export function createTracer(
  env: NodeJS.ProcessEnv = process.env,
  serviceName = env["OTEL_SERVICE_NAME"] ?? "averis",
): Tracer {
  const endpoint = env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  const requested = (env["TRACING_EXPORTER"] ?? (endpoint ? "otlp" : "none")).toLowerCase();

  const exporter: SpanExporter =
    requested === "otlp" && endpoint
      ? new OtlpHttpExporter({
          endpoint,
          serviceName,
          headers: parseHeaders(env["OTEL_EXPORTER_OTLP_HEADERS"]),
        })
      : requested === "console"
        ? new ConsoleExporter()
        : new NoopExporter();

  return new Tracer({
    serviceName,
    exporter,
    sampleRate: parseRate(env["TRACING_SAMPLE_RATE"]),
  });
}

/** `key1=value1,key2=value2`, the format the OTLP spec defines for headers. */
function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return out;
}

function parseRate(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 1;
}
