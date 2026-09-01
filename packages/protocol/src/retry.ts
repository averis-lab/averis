import { LLMError } from "@averis/agent-runtime";

/** Extra attempts after the first, for failures the provider called transient. */
const AGENT_RETRIES = 2;
/** Waits before each retry. Long enough for a rate limit, short enough for a deadline. */
const AGENT_RETRY_BACKOFF_MS = [1_500, 4_000];

/** Waits, unless the job is cancelled first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Runs an agent, retrying only what the provider said was worth retrying.
 *
 * `LLMError.retryable` was computed carefully by every adapter and read by
 * nobody, so a 429 or a 502 from one vendor retired that agent for the whole
 * job. That is the difference between a cohort of three and a cohort of two,
 * and the merge reports the shortfall as a discount on consensus — so a
 * transient upstream error was quietly showing up as weaker intelligence.
 *
 * Three deliberate limits.
 *
 * Only `retryable` errors. A model that returned unparseable output or
 * failed the schema is telling you something about the model, and paying it
 * to say the same thing again is not a fix.
 *
 * Inside the budget reservation, not around it. `withBudget` keeps the full
 * estimate when work throws, precisely so a crash-looping agent cannot spend
 * without limit; retrying outside would book a fresh reservation per attempt
 * and drain the job's budget on the retries themselves. Here one reservation
 * covers every attempt and reconciles against what was actually spent.
 *
 * Bounded and short. A job has a deadline, so the ceiling is small enough
 * that a dead vendor costs seconds rather than the job.
 *
 * What this cannot recover is the spend of a failed attempt: an `LLMError`
 * carries no usage. For the errors it retries — no completion, refused,
 * rate-limited — that spend is approximately nothing, which is what makes
 * the omission acceptable rather than merely convenient.
 */
export async function runWithRetries<T>(
  attempt: () => Promise<T>,
  options: {
    signal: AbortSignal;
    onRetry: (detail: {
      attempt: number;
      of: number;
      waitMs: number;
      reason: string;
    }) => void;
    retries?: number;
    backoffMs?: readonly number[];
  },
): Promise<T> {
  const retries = options.retries ?? AGENT_RETRIES;
  const backoff = options.backoffMs ?? AGENT_RETRY_BACKOFF_MS;
  let lastError: unknown;

  for (let tries = 0; tries <= retries; tries += 1) {
    if (tries > 0) {
      const waitMs = backoff[tries - 1] ?? backoff[backoff.length - 1] ?? 0;
      options.onRetry({
        attempt: tries + 1,
        of: retries + 1,
        waitMs,
        reason:
          lastError instanceof Error ? lastError.message : String(lastError),
      });
      await sleep(waitMs, options.signal);
    }

    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      // Anything else — a schema failure, an abort, a bug — stops here.
      if (!(error instanceof LLMError) || !error.retryable) throw error;
      if (options.signal.aborted) throw error;
    }
  }

  throw lastError;
}
