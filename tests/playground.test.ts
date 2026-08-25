import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENDPOINTS, buildPath, findEndpoint, toCurl } from "@/lib/playground";

/**
 * The playground proxy holds the gateway key on behalf of anyone who opens the
 * page, so its guards are not cosmetic: they are the reason a public page
 * cannot be turned into an open proxy. These were verified by hand once; this
 * file is what keeps them verified.
 */

const GATEWAY = "http://gateway.test:4000";

beforeAll(() => {
  process.env["AVERIS_API_URL"] = GATEWAY;
  process.env["AVERIS_API_KEY"] = "root-test-key";
});

/** The route reads its gateway at module load, so it is imported after the env. */
async function handler() {
  const route = await import("@/app/api/playground/route");
  return route.POST;
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/playground", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stubFetch(response: Response) {
  const spy = vi.fn(async () => response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalogue integrity", () => {
  it("has unique ids", () => {
    const ids = ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares every path parameter it interpolates", () => {
    for (const endpoint of ENDPOINTS) {
      const used = [...endpoint.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => m[1]);
      const declared = (endpoint.params ?? []).map((p) => p.name);
      expect(used.every((name) => declared.includes(name!)), endpoint.id).toBe(true);
    }
  });

  it("ships a valid JSON body for every writing endpoint", () => {
    for (const endpoint of ENDPOINTS.filter((e) => e.method === "POST")) {
      expect(() => JSON.parse(endpoint.body ?? ""), endpoint.id).not.toThrow();
    }
  });
});

describe("buildPath", () => {
  it("fills declared parameters", () => {
    const { path, missing } = buildPath(findEndpoint("jobs.get")!, { id: "job_1" });
    expect(path).toBe("/v1/jobs/job_1");
    expect(missing).toEqual([]);
  });

  it("reports a missing required parameter instead of building a broken path", () => {
    const { missing } = buildPath(findEndpoint("jobs.intelligence")!, {});
    expect(missing).toEqual(["id"]);
  });

  it("encodes a parameter so it cannot climb out of its segment", () => {
    const { path } = buildPath(findEndpoint("jobs.get")!, { id: "../../v1/agents" });
    expect(path).toBe("/v1/jobs/..%2F..%2Fv1%2Fagents");
    expect(path).not.toContain("/../");
  });

  it("keeps declared query keys and drops everything else", () => {
    const { path } = buildPath(
      findEndpoint("jobs.list")!,
      {},
      { limit: "5", status: "RESOLVED", requesterId: "someone-else", admin: "true" },
    );
    expect(path).toContain("limit=5");
    expect(path).toContain("status=RESOLVED");
    expect(path).not.toContain("requesterId");
    expect(path).not.toContain("admin");
  });

  it("omits empty query values rather than sending blanks", () => {
    const { path } = buildPath(findEndpoint("datanets.list")!, {}, { search: "   ", limit: "3" });
    expect(path).toBe("/v1/datanets?limit=3");
  });
});

describe("toCurl", () => {
  it("carries the auth header for authenticated endpoints", () => {
    const curl = toCurl(findEndpoint("jobs.list")!, "/v1/jobs", "");
    expect(curl).toContain("Authorization: Bearer $AVERIS_API_KEY");
  });

  it("leaves it off /health, which needs no key", () => {
    expect(toCurl(findEndpoint("health")!, "/health", "")).not.toContain("Authorization");
  });

  it("sends the body on a write", () => {
    const curl = toCurl(findEndpoint("jobs.create")!, "/v1/jobs", '{"a":1}');
    expect(curl).toContain("-X POST");
    expect(curl).toContain(`-d '{"a":1}'`);
  });
});

describe("proxy guards", () => {
  it("refuses an endpoint that is not in the catalogue", async () => {
    const spy = stubFetch(new Response("{}"));
    const response = await (await handler())(post({ endpointId: "../../etc/passwd" }));

    expect(response.status).toBe(400);
    // The point is not the status code: nothing was forwarded at all.
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a request missing a required parameter", async () => {
    const spy = stubFetch(new Response("{}"));
    const response = await (await handler())(post({ endpointId: "jobs.get", params: {} }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("id") });
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const spy = stubFetch(new Response("{}"));
    const response = await (await handler())(post({ endpointId: "jobs.create", body: "{nope" }));

    expect(response.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an oversized body", async () => {
    const spy = stubFetch(new Response("{}"));
    const response = await (await handler())(
      post({ endpointId: "jobs.create", body: "x".repeat(120_000) }),
    );

    expect(response.status).toBe(413);
    expect(spy).not.toHaveBeenCalled();
  });

  it("attaches the key server-side and forwards only the built path", async () => {
    const spy = stubFetch(new Response(JSON.stringify({ data: { id: "job_1" } }), { status: 200 }));
    await (await handler())(post({ endpointId: "jobs.get", params: { id: "job_1" } }));

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${GATEWAY}/v1/jobs/job_1`);
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer root-test-key");
  });

  it("never lets a caller choose the host", async () => {
    const spy = stubFetch(new Response("{}"));
    await (await handler())(
      post({ endpointId: "jobs.get", params: { id: "x" }, path: "http://evil.test/steal" }),
    );

    const [url] = spy.mock.calls[0] as unknown as [string];
    expect(url.startsWith(GATEWAY)).toBe(true);
    expect(url).not.toContain("evil.test");
  });

  it("reports an unreachable gateway as advice rather than a stack trace", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    const response = await (await handler())(post({ endpointId: "health" }));

    const body = (await response.json()) as { status: number; body: { error: string } };
    expect(body.status).toBe(0);
    expect(body.body.error).toContain("dev:api");
  });
});
