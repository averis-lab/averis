import { currentTraceparent } from "@averis/tracing";

/**
 * Trace propagation across the queue.
 *
 * This is the hop that nothing instruments for you. An HTTP call carries its
 * parent in a header the other side already reads; a queue message is just
 * bytes in a table, so the context has to be written into the message and read
 * back out, or the trace ends at the enqueue and a second, unrelated one
 * begins in the worker.
 *
 * It lives in the driver rather than at the call sites deliberately: there are
 * four `enqueue` calls in the protocol today and there will be more, and a hop
 * that has to be remembered is a hop that will eventually be forgotten.
 */

/** Marks a wrapped payload. Prefixed so it cannot collide with a real field. */
const TRACE_KEY = "__averisTrace";

interface TracedEnvelope {
  [TRACE_KEY]: string;
  payload: unknown;
}

/** The active `traceparent`, or undefined when nothing is being traced. */
export const captureTraceparent = (): string | undefined => currentTraceparent();

function isTraced(value: unknown): value is TracedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)[TRACE_KEY] === "string" &&
    "payload" in value
  );
}

/**
 * Wraps a payload so it carries its trace context, for drivers whose transport
 * has no metadata of its own to put it in.
 *
 * Only wraps when there is something to carry. With tracing off — the default
 * — the payload goes onto the wire byte for byte as it did before this
 * existed, so enabling tracing is not a wire-format migration and a message
 * enqueued by an older process still reads correctly.
 */
export function packTrace<T>(payload: T, traceparent: string | undefined): T | TracedEnvelope {
  if (!traceparent) return payload;
  return { [TRACE_KEY]: traceparent, payload };
}

/** Reverses `packTrace`, tolerating a payload that was never wrapped. */
export function unpackTrace(data: unknown): { payload: unknown; traceparent: string | undefined } {
  if (isTraced(data)) return { payload: data.payload, traceparent: data[TRACE_KEY] };
  return { payload: data, traceparent: undefined };
}
