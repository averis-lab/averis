import type { FastifyInstance } from "fastify";
import { formatTraceparent, withContext, type Span, type Tracer } from "@averis/tracing";

declare module "fastify" {
  interface FastifyRequest {
    /** The server span for this request. Present once tracing is registered. */
    span?: Span;
  }
}

/**
 * Opens a server span per request and makes it the ambient context.
 *
 * The gateway is where a trace usually begins, but not always: a caller that
 * sends its own `traceparent` is continued rather than overridden, which is
 * what lets one trace span a client, this API and the workers it queues work
 * for.
 *
 * `onRequest` and `onResponse` are used rather than a wrapper around each
 * handler so the span covers the parts a handler never sees — body parsing,
 * auth, rate limiting, serialization.
 */
export function registerTracing(app: FastifyInstance, tracer: Tracer): void {
  app.addHook("onRequest", (request, reply, done) => {
    const span = tracer.startSpan(`${request.method} ${routeOf(request.url)}`, {
      kind: "server",
      parent: header(request.headers["traceparent"]),
      attributes: {
        "http.request.method": request.method,
        "url.path": routeOf(request.url),
        "server.address": request.hostname,
      },
    });

    request.span = span;

    // Handed back on every response, sampled or not. Without it a caller
    // reporting a slow request has no way to say *which* request, and finding
    // it by timestamp across a busy gateway is guesswork.
    void reply.header("traceparent", formatTraceparent(span.context));

    // The rest of the request runs inside the span's context, so anything it
    // enqueues is captured by the queue driver as a child of this span.
    withContext(span.context, done);
  });

  app.addHook("onResponse", (request, reply, done) => {
    const span = request.span;
    if (span) {
      span.setAttributes({
        "http.response.status_code": reply.statusCode,
        // Fastify resolves the matched route only once routing has run, so it
        // is read here rather than at onRequest where it is still unknown.
        "http.route": request.routeOptions?.url ?? undefined,
      });
      // 5xx is the server's fault and marks the span failed; 4xx is the
      // caller being told no, which is a successful request to have handled.
      if (reply.statusCode >= 500) span.recordError(new Error(`HTTP ${reply.statusCode}`));
      span.end();
    }
    done();
  });

  // A request that never produces a response — the connection dropped, or the
  // serializer threw — would otherwise leave its span open forever.
  app.addHook("onRequestAbort", (request, done) => {
    request.span?.setAttribute("http.aborted", true);
    request.span?.end();
    done();
  });
}

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Path without the query string, which can carry identifiers and secrets. */
function routeOf(url: string): string {
  const index = url.indexOf("?");
  return index === -1 ? url : url.slice(0, index);
}
