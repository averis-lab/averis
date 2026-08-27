# Tracing

One trace from the HTTP request through every worker stage it sets off.

Cost and latency were already recorded per run and reported on the dashboard —
that data lived in the database, read back from what each run actually did.
This is different work and answers a different question: not *what did it cost*
but *where did the time go, and which hop failed*.

## Off by default

Nothing is recorded unless it is asked for. Spans are still created and still
propagate when tracing is off, so a request arriving from a traced service
keeps its ids, but nothing is retained or sent anywhere.

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector base URL, e.g. `http://localhost:4318`. Setting it is enough — the exporter switches to `otlp` on its own. |
| `TRACING_EXPORTER` | `otlp`, `console`, or `none`. Defaults to `otlp` when an endpoint is set, `none` otherwise. |
| `OTEL_SERVICE_NAME` | Service name on the spans. Defaults to `averis`. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `key=value,key=value`, for a collector that wants an auth header. |
| `TRACING_SAMPLE_RATE` | Fraction of *root* traces recorded, 0..1. Default 1. |

`TRACING_EXPORTER=otlp` with no endpoint falls back to recording nothing rather
than failing at startup: an unreachable collector is not a reason for the
gateway to refuse to boot.

## Why not the OpenTelemetry SDK

The wire format is OTLP and the propagation format is W3C Trace Context, so
this is interoperable with everything that speaks them — Jaeger, Tempo,
Honeycomb. What is not here is the OpenTelemetry SDK, and the reason is
narrow: the hop this system actually needed stitched is the **queue**, and no
SDK auto-instruments that. A queue message is bytes in a table, so the context
has to be written into the message and read back out by hand either way. Given
that the interesting half had to be hand-written, ~15 packages to
auto-instrument the easy half was not a trade worth making.

`OtlpHttpExporter` posts OTLP/HTTP JSON with `fetch`. Export is
fire-and-forget: a collector being down is reported through `onError` and the
batch is dropped, never retried into a growing buffer, and never surfaced to
the caller. A job does not fail because a tracing backend did.

## Where the context is threaded

```
HTTP request ──▶ gateway span ──▶ enqueue ──▶ queue ──▶ worker span ──▶ enqueue ──▶ …
   traceparent      onRequest       driver     message      driver
```

**Gateway** (`apps/api/src/tracing.ts`). An `onRequest` hook opens a server
span and makes it the ambient context, so anything the request enqueues is
captured as a child. An inbound `traceparent` is continued rather than
overridden. Every response carries a `traceparent` back, sampled or not —
without it, a caller reporting a slow request has no way to say which one.

The span is opened in `onRequest` and closed in `onResponse` rather than around
the handler, so it covers body parsing, auth, rate limiting and serialization
too. 5xx marks the span failed; 4xx does not — a rejected caller is a request
handled correctly.

**Queue** (`packages/queue/src/trace.ts`). Propagation lives in the *driver*,
not at the call sites. There are four `enqueue` calls in the protocol today and
there will be more, and a hop that has to be remembered is a hop that will
eventually be forgotten. Each driver captures the active `traceparent` at
enqueue and restores it around the handler:

- **pgmq** — a field on the message envelope it already had.
- **BullMQ** — inside the job data, which is the only field of a BullMQ job the
  driver controls.
- **memory** — a field on the in-process message. Restored explicitly rather
  than left to async-context inheritance, because the retry and delay paths run
  from a timer where the enqueuing context is long gone.

In all three the field is written **only when there is a trace to carry**. With
tracing off the payload goes onto the wire byte for byte as it did before, so
turning tracing on is not a wire-format migration and a queue drained across a
deploy reads correctly either way.

**Workers** (`workers/src/traced.ts`). Each handler is wrapped in a consumer
span carrying the queue, the message id, the attempt number, and the job id —
which is what makes a trace searchable by the identifier a user actually has.
A message that arrived with no context starts a fresh trace: the operator loop
and the resolution sweep queue work with no request behind them, and they are
worth seeing.

## Sampling

The decision is made once, by whoever roots the trace, and inherited from there
on. A trace that arrives sampled stays sampled and one that arrives unsampled
stays unsampled, so a single request never lands half-recorded across services.
Re-rolling per span would produce traces with holes in them, which are harder
to read than no trace at all.

## What has been run

- Gateway → job → evaluation → consensus, in **one trace**, against a real
  Postgres and the real lifecycle: `tests/integration/tracing.test.ts`.
- The **BullMQ** path against a real Redis, in the same file.
- The **OTLP exporter** against a real Jaeger collector, which accepted the
  spans and reconstructed the parent/child chain.
- The **pgmq** path with the SQL stubbed (`tests/tracing.test.ts`). The
  envelope is serialized and parsed exactly as jsonb would be, but the pgmq
  extension is not in the local Postgres image, so those statements are faked.
  This is the one path not yet exercised against the real thing.

Nothing here has run in production yet.
