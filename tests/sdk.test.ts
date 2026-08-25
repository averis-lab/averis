import { describe, expect, it } from "vitest";
import { AverisError, PaymentRequiredError, createClient } from "@averis/sdk";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch stand-in that records calls and replays queued responses. */
function fakeFetch(queue: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];

  const impl = (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    });

    const next = queue.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: next.headers,
    });
  }) as typeof fetch;

  return { impl, calls };
}

const job = (status: string, id = "job_1") => ({ data: { id, status } });

const challenge = (accepts: unknown[]) => ({
  "payment-required": Buffer.from(JSON.stringify({ x402Version: 2, accepts })).toString("base64"),
});

const OPTION = {
  scheme: "exact",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  amount: "250000",
  payTo: "9xQeWvG816bUx9EPa2mNSMh1p4hbGRQ7pd5yPeeeeeee",
};

describe("request plumbing", () => {
  it("sends the key as a bearer token and trims the base URL", async () => {
    const { impl, calls } = fakeFetch([{ body: { data: [] } }]);
    const client = createClient({ baseUrl: "http://gateway:4000///", apiKey: "av_key", fetchImpl: impl });

    await client.listAgents();

    expect(calls[0]!.url).toBe("http://gateway:4000/v1/agents");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer av_key");
  });

  it("omits the header entirely when no key is configured", async () => {
    const { impl, calls } = fakeFetch([{ body: { data: [] } }]);
    await createClient({ fetchImpl: impl }).listJobs();
    expect(calls[0]!.headers["authorization"]).toBeUndefined();
  });

  it("surfaces the gateway's own error message", async () => {
    const { impl } = fakeFetch([{ status: 404, body: { error: "Job not found" } }]);
    const client = createClient({ fetchImpl: impl });

    const error = await client.getJob("missing").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AverisError);
    expect((error as AverisError).status).toBe(404);
    expect((error as AverisError).message).toBe("Job not found");
  });
});

describe("payment required", () => {
  it("decodes what the gateway is asking for", async () => {
    const { impl } = fakeFetch([{ status: 402, body: {}, headers: challenge([OPTION]) }]);
    const client = createClient({ fetchImpl: impl });

    const error = await client
      .createJob({ type: "dataset-evaluation", query: "a query long enough to pass", budget: 1 } as never)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentRequiredError);
    const payment = error as PaymentRequiredError;
    expect(payment.status).toBe(402);
    expect(payment.accepts).toHaveLength(1);
    expect(payment.accepts[0]).toMatchObject({ amount: "250000", scheme: "exact" });
    // The message has to tell a caller how to succeed next time.
    expect(payment.message).toContain("250000");
    expect(payment.message).toContain("fetchImpl");
  });

  it("still raises a payment error when the challenge is unreadable", async () => {
    const { impl } = fakeFetch([
      { status: 402, body: {}, headers: { "payment-required": "not-base64-json" } },
    ]);
    const error = await createClient({ fetchImpl: impl })
      .createJob({ type: "x", query: "a query long enough to pass", budget: 1 } as never)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PaymentRequiredError);
    expect((error as PaymentRequiredError).accepts).toEqual([]);
  });

  it("is an AverisError, so existing catch blocks keep working", async () => {
    const { impl } = fakeFetch([{ status: 402, body: {}, headers: challenge([OPTION]) }]);
    const error = await createClient({ fetchImpl: impl })
      .getStats()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AverisError);
  });
});

describe("runJob", () => {
  it("polls until the job resolves and returns the report", async () => {
    const seen: string[] = [];
    const { impl } = fakeFetch([
      { body: job("CREATED") },
      { body: job("RUNNING") },
      { body: job("RUNNING") },
      { body: job("RESOLVED") },
      { body: { data: { intelligence: { summary: "done" } } } },
    ]);

    const report = await createClient({ fetchImpl: impl }).runJob(
      { type: "dataset-evaluation", query: "a query long enough to pass", budget: 1 } as never,
      { pollMs: 1, onStatus: (status) => seen.push(status) },
    );

    expect((report as { intelligence: { summary: string } }).intelligence.summary).toBe("done");
    // Status changes are reported once each, not once per poll.
    expect(seen).toEqual(["CREATED", "RUNNING", "RESOLVED"]);
  });

  it("throws rather than returning a result the protocol failed", async () => {
    const { impl } = fakeFetch([
      { body: job("CREATED") },
      { body: { data: { id: "job_1", status: "FAILED", failureReason: "below minimum confidence" } } },
    ]);

    await expect(
      createClient({ fetchImpl: impl }).runJob(
        { type: "dataset-evaluation", query: "a query long enough to pass", budget: 1 } as never,
        { pollMs: 1 },
      ),
    ).rejects.toThrow(/below minimum confidence/);
  });
});
