import type { MessageHandler, QueueMessage, QueueName } from "@averis/queue";
import type { ProtocolContext } from "@averis/protocol";

/**
 * Wraps a message handler in a consumer span.
 *
 * The driver has already restored the enqueuing context by the time this runs,
 * so the span it opens attaches to whatever queued the work — the HTTP request
 * that created the job, or the worker stage before this one. That is the whole
 * point of the exercise: one trace from the gateway through all four stages,
 * rather than five unrelated traces that happen to mention the same job id.
 *
 * A message that arrived without a trace context starts its own trace here.
 * The operator loop and the resolution sweep queue work with no request behind
 * them, and they are worth seeing.
 */
export function traced<T extends { jobId?: string }>(
  ctx: ProtocolContext,
  queue: QueueName,
  handler: MessageHandler<T>,
): MessageHandler<T> {
  return (message: QueueMessage<T>) =>
    ctx.tracer.withSpan(
      `${queue} receive`,
      () => handler(message),
      {
        kind: "consumer",
        attributes: {
          "messaging.system": ctx.queue.name,
          "messaging.destination.name": queue,
          "messaging.message.id": message.id,
          "messaging.operation.name": message.name,
          // Retries are the thing worth spotting in a trace, and a first
          // attempt is the uninteresting case, so it is recorded either way.
          "messaging.attempt": message.attempt,
          ...(message.payload?.jobId ? { "averis.job.id": message.payload.jobId } : {}),
        },
      },
    );
}
