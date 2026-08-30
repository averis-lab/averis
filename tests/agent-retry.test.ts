import { describe, expect, it, vi } from "vitest";
import { LLMError } from "@averis/agent-runtime";
import { runWithRetries } from "../packages/protocol/src/retry";

/**
 * Retrying what the provider said was transient.
 *
 * Every adapter computed `LLMError.retryable` and nothing read it, so a 429 or
 * a 502 from one vendor retired that agent for the whole job — and the merge,
 * seeing a short cohort, reported the shortfall as weaker consensus. A vendor
 * hiccup was arriving as worse intelligence.
 */
const noWait = { backoffMs: [0, 0] as const, onRetry: () => {} };
const live = () => new AbortController().signal;

describe("runWithRetries", () => {
  it("returns the first success without retrying", async () => {
    const attempt = vi.fn(async () => "ok");
    await expect(runWithRetries(attempt, { signal: live(), ...noWait })).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries a failure the provider called transient, and keeps the result", async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new LLMError("openrouter", "no completion: overloaded", true))
      .mockResolvedValueOnce("second time");

    await expect(runWithRetries(attempt, { signal: live(), ...noWait })).resolves.toBe("second time");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure the provider called permanent", async () => {
    // A 402 or a bad model id will say the same thing every time.
    const attempt = vi.fn(async () => {
      throw new LLMError("openrouter", "402 requires more credits", false);
    });

    await expect(runWithRetries(attempt, { signal: live(), ...noWait })).rejects.toThrow(/credits/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry a model that failed the schema", async () => {
    // Paying a model to say the same unparseable thing again is not a fix.
    const attempt = vi.fn(async () => {
      throw new Error('Agent "Markets Agent" returned output that does not satisfy the schema');
    });

    await expect(runWithRetries(attempt, { signal: live(), ...noWait })).rejects.toThrow(/schema/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("gives up after a bounded number of attempts, surfacing the last failure", async () => {
    const attempt = vi.fn(async () => {
      throw new LLMError("openrouter", "still overloaded", true);
    });

    await expect(
      runWithRetries(attempt, { signal: live(), retries: 2, ...noWait }),
    ).rejects.toThrow(/still overloaded/);
    // A dead vendor costs three attempts, not the job.
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("stops once the job is cancelled", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => {
      controller.abort();
      throw new LLMError("openrouter", "overloaded", true);
    });

    await expect(
      runWithRetries(attempt, { signal: controller.signal, ...noWait }),
    ).rejects.toThrow(/overloaded/);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("reports each retry, so a flaky vendor is visible rather than merely slow", async () => {
    const onRetry = vi.fn();
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new LLMError("openrouter", "502 upstream", true))
      .mockResolvedValueOnce("ok");

    await runWithRetries(attempt, { signal: live(), backoffMs: [0, 0], onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 2, of: 3, reason: expect.stringContaining("502") });
  });
});
