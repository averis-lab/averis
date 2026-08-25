import { describe, expect, it } from "vitest";
import { MemoryQueueDriver, QUEUES, normalizeJobId } from "@averis/queue";

/**
 * Contract the protocol relies on. The BullMQ driver must satisfy the same
 * assertions; where the two diverged (a `:` in a dedup key was fine in memory
 * and rejected by Redis) the pipeline broke only in production.
 */
describe("queue driver contract", () => {
  it("normalizes dedup keys to characters every driver accepts", () => {
    expect(normalizeJobId("job:abc123")).toBe("job-abc123");
    expect(normalizeJobId("eval:x/y z")).toBe("eval-x-y-z");
    expect(normalizeJobId("plain-id_1")).toBe("plain-id_1");
    // BullMQ rejects ":" outright, so it must never survive normalization.
    expect(normalizeJobId("a:b:c")).not.toContain(":");
  });

  it("delivers an enqueued message to its handler", async () => {
    const driver = new MemoryQueueDriver();
    const seen: string[] = [];
    driver.process<{ jobId: string }>(QUEUES.job, async (m) => {
      seen.push(m.payload.jobId);
    });

    await driver.enqueue(QUEUES.job, "run", { jobId: "a" });
    await driver.enqueue(QUEUES.job, "run", { jobId: "b" });
    await driver.drained();

    expect(seen.sort()).toEqual(["a", "b"]);
    await driver.close();
  });

  it("drops a duplicate enqueue with the same dedup key", async () => {
    const driver = new MemoryQueueDriver();
    let calls = 0;
    driver.process(QUEUES.job, async () => {
      calls++;
    });

    // Same logical job enqueued three times, as at-least-once delivery does.
    await driver.enqueue(QUEUES.job, "run", { jobId: "x" }, { jobId: "job:x" });
    await driver.enqueue(QUEUES.job, "run", { jobId: "x" }, { jobId: "job:x" });
    await driver.enqueue(QUEUES.job, "run", { jobId: "x" }, { jobId: "job-x" });
    await driver.drained();

    expect(calls).toBe(1);
    await driver.close();
  });

  it("retries a failing handler up to the attempt limit", async () => {
    const driver = new MemoryQueueDriver();
    let attempts = 0;
    driver.process(QUEUES.job, async () => {
      attempts++;
      throw new Error("boom");
    });

    const failures: string[] = [];
    driver.process(QUEUES.evaluation, async () => {});

    await driver.enqueue(QUEUES.job, "run", {}, { attempts: 3, backoffMs: 5 });
    await new Promise((r) => setTimeout(r, 250));

    expect(attempts).toBe(3);
    expect(failures).toEqual([]);
    await driver.close();
  });

  it("reports the failure once retries are exhausted", async () => {
    const driver = new MemoryQueueDriver();
    let failed: string | null = null;

    driver.process(
      QUEUES.job,
      async () => {
        throw new Error("permanent");
      },
      { onFailed: (_m, error) => { failed = error.message; } },
    );

    await driver.enqueue(QUEUES.job, "run", {}, { attempts: 2, backoffMs: 5 });
    await new Promise((r) => setTimeout(r, 250));

    expect(failed).toBe("permanent");
    await driver.close();
  });

  it("respects the concurrency limit", async () => {
    const driver = new MemoryQueueDriver();
    let running = 0;
    let peak = 0;

    driver.process(
      QUEUES.job,
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
      },
      { concurrency: 2 },
    );

    for (let i = 0; i < 8; i++) await driver.enqueue(QUEUES.job, "run", { i });
    await driver.drained();

    expect(peak).toBeLessThanOrEqual(2);
    await driver.close();
  });

  it("honours a delayed enqueue", async () => {
    const driver = new MemoryQueueDriver();
    let delivered = false;
    driver.process(QUEUES.job, async () => { delivered = true; });

    await driver.enqueue(QUEUES.job, "run", {}, { delayMs: 80 });
    expect(delivered).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    expect(delivered).toBe(true);
    await driver.close();
  });

  it("refuses to enqueue after close", async () => {
    const driver = new MemoryQueueDriver();
    await driver.close();
    await expect(driver.enqueue(QUEUES.job, "run", {})).rejects.toThrow(/closed/);
  });
});
