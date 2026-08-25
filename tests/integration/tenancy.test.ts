import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnect, prisma } from "@averis/db";
import { MemoryQueueDriver } from "@averis/queue";
import { createContext } from "@averis/protocol";
import { buildServer } from "../../apps/api/src/server";
import { generateApiKey, hashApiKey } from "../../apps/api/src/api-key";
import { resetDatabase, seedRegistry, silent } from "./harness";

/**
 * Tenancy, through the real gateway against the real database.
 *
 * The interesting failures here are not "does the filter work" but "is there a
 * path around it" — a job read by id, a cursor from someone else's page, a
 * count that quietly sums every tenant. Each of those is a query written
 * somewhere other than the list endpoint, so each needs its own case.
 */

const ROOT_KEY = "root-test-key";

// The create schema rejects a query too short to describe anything, so these
// are written out rather than named "job one".
const ALICE_ONE = "Assess whether the curated corpus is reliable enough to act on";
const ALICE_TWO = "Assess how much the curated market corpus disagrees with itself";
const BOBS = "Assess whether the curated corpus is worth trading against";
const ROOTS = "Sweep every curated datanet for anomalies worth escalating";

let app: FastifyInstance;
let queue: MemoryQueueDriver;
let alice: { id: string; key: string };
let bob: { id: string; key: string };

async function createAccount(handle: string): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const user = await prisma.user.create({ data: { handle, apiKeyHash: hashApiKey(key) } });
  return { id: user.id, key };
}

function post(key: string | null, query: string) {
  return app.inject({
    method: "POST",
    url: "/v1/jobs",
    ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
    payload: {
      type: "dataset-evaluation",
      query,
      requiredCapabilities: ["markets"],
      requiredAgents: 1,
      budget: 1,
    },
  });
}

/** Asserts the creation succeeded, so a fixture never fails silently. */
async function postOk(key: string, query: string): Promise<string> {
  const response = await post(key, query);
  expect(response.statusCode, response.body).toBe(201);
  return response.json().data.id as string;
}

function get(key: string | null, url: string) {
  return app.inject({
    method: "GET",
    url,
    ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
  });
}

beforeAll(async () => {
  queue = new MemoryQueueDriver();
  // No workers: a created job parks at QUEUED, which is all these cases need.
  const ctx = createContext({
    logger: silent,
    env: { ...process.env, API_KEYS: ROOT_KEY },
    overrides: { queue },
  });
  app = await buildServer({ ctx });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await queue?.close();
  await disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  await seedRegistry([{ name: "Markets Agent", domains: ["markets"] }]);
  alice = await createAccount("alice");
  bob = await createAccount("bob");
});

describe("authentication", () => {
  it("refuses a request with no key", async () => {
    expect((await get(null, "/v1/jobs")).statusCode).toBe(401);
  });

  it("refuses an unknown key", async () => {
    expect((await get(generateApiKey(), "/v1/jobs")).statusCode).toBe(401);
    expect((await get("not-even-close", "/v1/jobs")).statusCode).toBe(401);
  });

  it("accepts a minted account key", async () => {
    expect((await get(alice.key, "/v1/jobs")).statusCode).toBe(200);
  });

  it("leaves health reachable without a key", async () => {
    expect([200, 503]).toContain((await get(null, "/health")).statusCode);
  });

  it("stops accepting a rotated key", async () => {
    // Rotation replaces the hash; the old key now resolves to nobody. The
    // resolution cache only holds keys that have been used, and this one
    // has not been, so the new state is visible immediately.
    const replacement = generateApiKey();
    await prisma.user.update({
      where: { id: alice.id },
      data: { apiKeyHash: hashApiKey(replacement) },
    });

    expect((await get(alice.key, "/v1/jobs")).statusCode).toBe(401);
    expect((await get(replacement, "/v1/jobs")).statusCode).toBe(200);
  });
});

describe("job ownership", () => {
  it("stamps a created job with its requester", async () => {
    const created = await post(alice.key, ALICE_ONE);
    expect(created.statusCode).toBe(201);

    const job = await prisma.job.findUnique({
      where: { id: created.json().data.id },
      select: { requesterId: true },
    });
    expect(job?.requesterId).toBe(alice.id);
  });

  it("leaves a root-key job unowned", async () => {
    const created = await post(ROOT_KEY, ROOTS);
    const job = await prisma.job.findUnique({
      where: { id: created.json().data.id },
      select: { requesterId: true },
    });
    expect(job?.requesterId).toBeNull();
  });

  it("records the owner of an agent registered with an account key", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: { authorization: `Bearer ${bob.key}` },
      payload: {
        name: "Bob's Agent",
        modelProvider: "mock",
        modelName: "mock-analyst",
        capabilities: [{ domain: "markets", declared: 0.8 }],
      },
    });
    expect(registered.statusCode).toBe(201);

    const agent = await prisma.agent.findUnique({
      where: { name: "Bob's Agent" },
      select: { ownerId: true },
    });
    expect(agent?.ownerId).toBe(bob.id);
  });
});

describe("read scoping", () => {
  beforeEach(async () => {
    await postOk(alice.key, ALICE_ONE);
    await postOk(alice.key, ALICE_TWO);
    await postOk(bob.key, BOBS);
    await postOk(ROOT_KEY, ROOTS);
  });

  it("lists only the caller's own jobs", async () => {
    const queries = (body: { data: { query: string }[] }) => body.data.map((j) => j.query).sort();

    expect(queries((await get(alice.key, "/v1/jobs")).json())).toEqual(
      [ALICE_ONE, ALICE_TWO].sort(),
    );
    expect(queries((await get(bob.key, "/v1/jobs")).json())).toEqual([BOBS]);
  });

  it("shows every job to a root key", async () => {
    expect((await get(ROOT_KEY, "/v1/jobs")).json().data).toHaveLength(4);
  });

  it("returns 404, not 403, for another account's job", async () => {
    const bobsJob = (await get(bob.key, "/v1/jobs")).json().data[0].id;

    // 403 would confirm the id exists. A reader who cannot see a job should
    // not be able to tell it apart from one that was never created.
    expect((await get(alice.key, `/v1/jobs/${bobsJob}`)).statusCode).toBe(404);
    expect((await get(alice.key, `/v1/jobs/${bobsJob}/intelligence`)).statusCode).toBe(404);
    expect((await get(bob.key, `/v1/jobs/${bobsJob}`)).statusCode).toBe(200);
  });

  it("does not leak another account's job through a stolen cursor", async () => {
    const bobsJob = (await get(bob.key, "/v1/jobs")).json().data[0].id;
    const page = await get(alice.key, `/v1/jobs?cursor=${bobsJob}&limit=20`);

    expect(page.statusCode).toBe(200);
    for (const job of page.json().data) expect(job.query).not.toBe(BOBS);
  });

  it("does not leak another account's job through a status filter", async () => {
    const page = await get(bob.key, "/v1/jobs?status=QUEUED&type=dataset-evaluation");
    expect(page.json().data.map((j: { query: string }) => j.query)).toEqual([BOBS]);
  });

  it("counts only the caller's own jobs in stats", async () => {
    expect((await get(alice.key, "/v1/stats")).json().data.jobs).toBe(2);
    expect((await get(bob.key, "/v1/stats")).json().data.jobs).toBe(1);
    expect((await get(ROOT_KEY, "/v1/stats")).json().data.jobs).toBe(4);
  });

  it("keeps the agent registry shared across tenants", async () => {
    // Agents are selected by capability, not ownership: scoping the registry
    // per tenant would quietly starve every cohort of its specialists.
    const agents = (await get(alice.key, "/v1/agents")).json().data;
    expect(agents.length).toBeGreaterThan(0);
  });
});
