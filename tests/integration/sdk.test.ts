import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnect } from "@averis/db";
import { AverisError, createClient, type AverisClient } from "@averis/sdk";
import { buildServer } from "../../apps/api/src/server";
import { resetDatabase, seedRegistry, startPipeline, type Harness } from "./harness";

/**
 * The SDK against the real gateway, over real HTTP, with the real pipeline
 * behind it.
 *
 * The unit tests in `tests/sdk.test.ts` drive a fake fetch: they prove the
 * client's plumbing, not that it can talk to this API. This file is the other
 * half — it caught nothing when written, which is the point of writing it
 * before something breaks rather than after.
 */

const KEY = "sdk-integration-key";

let harness: Harness;
let app: FastifyInstance;
let client: AverisClient;

beforeAll(async () => {
  await resetDatabase();
  await seedRegistry([
    { name: "Markets Agent", domains: ["markets", "geopolitics"] },
    { name: "Research Agent", domains: ["research", "markets"] },
    { name: "Data Quality Agent", domains: ["research", "ai"] },
  ]);

  harness = startPipeline({ env: { ...process.env, API_KEYS: KEY } });
  app = await buildServer({ ctx: harness.ctx });

  // Port 0: the OS picks a free one, so a developer with the gateway already
  // running locally does not get a confusing bind error.
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  client = createClient({ baseUrl: address, apiKey: KEY });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await harness?.stop();
  await disconnect();
});

describe("reads", () => {
  it("returns the seeded registry", async () => {
    const agents = (await client.listAgents()) as Array<{ id: string; name: string }>;
    expect(agents.map((a) => a.name).sort()).toEqual([
      "Data Quality Agent",
      "Markets Agent",
      "Research Agent",
    ]);

    const agent = (await client.getAgent(agents[0]!.id)) as { status: string };
    expect(agent.status).toBe("ACTIVE");
  });

  it("counts what exists", async () => {
    const stats = await client.getStats();
    expect(stats.activeAgents).toBe(3);
  });

  it("reads datanets and their items from the upstream provider", async () => {
    const datanets = (await client.listDatanets({ limit: 3 })) as Array<{ id: string }>;
    expect(datanets.length).toBeGreaterThan(0);

    const items = (await client.listDatanetData(datanets[0]!.id, { limit: 2 })) as unknown[];
    expect(Array.isArray(items)).toBe(true);
  });
});

describe("errors", () => {
  it("rejects a request carrying no key", async () => {
    const anonymous = createClient({ baseUrl: `http://127.0.0.1:${port()}` });
    const error = await anonymous.listJobs().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AverisError);
    expect((error as AverisError).status).toBe(401);
  });

  it("maps a missing job to a 404 carrying the gateway's own message", async () => {
    const error = await client.getJob("no-such-job").catch((e: unknown) => e);

    expect((error as AverisError).status).toBe(404);
    expect((error as AverisError).message).toBe("Job not found");
  });
});

describe("runJob", () => {
  it("drives a job through the whole pipeline and returns the merged report", async () => {
    const seen: string[] = [];

    const report = (await client.runJob(
      {
        type: "dataset-evaluation",
        query: "Assess whether the curated corpus is reliable enough to act on",
        requiredCapabilities: ["markets", "research"],
        requiredAgents: 3,
        budget: 3,
      } as never,
      { pollMs: 50, timeoutMs: 60_000, onStatus: (s) => seen.push(s) },
    )) as {
      intelligence: { summary: string; confidence: number; claims: unknown[] };
      contributions: unknown[];
      evidence: unknown[];
    };

    expect(seen[seen.length - 1]).toBe("RESOLVED");
    expect(report.intelligence.claims.length).toBeGreaterThan(0);
    expect(report.intelligence.confidence).toBeGreaterThan(0);
    // Three agents were asked for and three contributed; evidence was actually
    // recorded rather than the report merely being well-formed.
    expect(report.contributions).toHaveLength(3);
    expect(report.evidence.length).toBeGreaterThan(0);
  }, 90_000);
});

/** The port Fastify actually bound to. */
function port(): number {
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("server is not bound");
  return address.port;
}
