import { describe, expect, it } from "vitest";
import {
  ReppoAuthError,
  ReppoFixtureProvider,
  ReppoHttpProvider,
  curationQuality,
  inferDomains,
  normalizePod,
  POD_SATURATION,
  withFixtureFallback,
} from "@averis/reppo-adapter";
import { DataItemSchema, DatanetSchema } from "@averis/types";

describe("curation quality", () => {
  it("returns no-information 0.5 when nothing has been voted", () => {
    expect(curationQuality(0, 0, POD_SATURATION)).toEqual({ approvalRate: 0.5, quality: 0.5 });
  });

  it("shrinks a thinly-voted perfect score toward neutral", () => {
    const thin = curationQuality(10, 0, POD_SATURATION);
    const heavy = curationQuality(500_000, 0, POD_SATURATION);

    expect(thin.approvalRate).toBe(1);
    expect(heavy.approvalRate).toBe(1);
    // Same approval rate, but the thin one carries far less weight.
    expect(thin.quality).toBeLessThan(heavy.quality);
    expect(heavy.quality).toBeCloseTo(1, 5);
    expect(thin.quality).toBeLessThan(0.75);
  });

  it("is monotone in approval rate at equal volume", () => {
    const bad = curationQuality(200, 800, POD_SATURATION);
    const mixed = curationQuality(500, 500, POD_SATURATION);
    const good = curationQuality(800, 200, POD_SATURATION);

    expect(bad.quality).toBeLessThan(mixed.quality);
    expect(mixed.quality).toBeLessThan(good.quality);
    expect(mixed.quality).toBeCloseTo(0.5, 10);
  });

  it("never leaves the unit interval", () => {
    for (const [up, down] of [[0, 1e9], [1e9, 0], [1, 1], [3, 7]] as const) {
      const { quality } = curationQuality(up, down, POD_SATURATION);
      expect(quality).toBeGreaterThanOrEqual(0);
      expect(quality).toBeLessThanOrEqual(1);
    }
  });
});

describe("domain inference", () => {
  it("tags a defi datanet with its domains", () => {
    const domains = inferDomains("Solana DeFi Liquidity", "Tracks AMM liquidity and TVL");
    expect(domains).toContain("defi");
    expect(domains).toContain("solana");
  });

  it("never returns an empty tag set", () => {
    expect(inferDomains("", null, undefined)).toEqual(["general"]);
  });
});

describe("pod normalization", () => {
  it("zeroes the weight of a banned pod regardless of its votes", () => {
    const item = normalizePod({
      id: "p1",
      name: "Banned",
      description: "",
      tokenId: 1,
      privateSubnetId: "s1",
      url: null,
      imageUrl: null,
      thumbnailUrl: null,
      videoUrl: null,
      pdfUrl: null,
      creator: null,
      status: "ACTIVE",
      banned: true,
      banReason: "spam",
      podValidityEpoch: 1,
      cumulativeUpVotesVolume: 5_000_000,
      cumulativeDownVotesVolume: 0,
      chainId: 8453,
      createdAt: null,
      updatedAt: null,
    });
    expect(item.qualityScore).toBe(0);
  });
});

describe("fixture provider (recorded live payloads)", () => {
  const provider = new ReppoFixtureProvider();

  it("normalizes every recorded datanet into the domain schema", async () => {
    const datanets = await provider.listDatanets({ limit: 100 });
    expect(datanets.length).toBeGreaterThan(5);
    for (const d of datanets) {
      expect(() => DatanetSchema.parse(d)).not.toThrow();
      expect(d.domains.length).toBeGreaterThan(0);
    }
  });

  it("normalizes every recorded pod into the domain schema", async () => {
    const items = await provider.searchData({ limit: 200 });
    expect(items.length).toBeGreaterThan(20);
    for (const item of items) {
      expect(() => DataItemSchema.parse(item)).not.toThrow();
      expect(item.qualityScore).toBeGreaterThanOrEqual(0);
      expect(item.qualityScore).toBeLessThanOrEqual(1);
    }
  });

  it("scopes data retrieval to the requested datanet", async () => {
    const [datanet] = await provider.listDatanets({ limit: 1 });
    expect(datanet).toBeDefined();
    const items = await provider.listData(datanet!.id, { limit: 10 });
    for (const item of items) expect(item.datanetId).toBe(datanet!.id);
  });

  it("returns results sorted by curation quality", async () => {
    const [datanet] = await provider.listDatanets({ limit: 1 });
    const items = await provider.listData(datanet!.id, { limit: 10 });
    const scores = items.map((i) => i.qualityScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("honours the quality floor", async () => {
    const items = await provider.searchData({ minQuality: 0.6, limit: 50 });
    for (const item of items) expect(item.qualityScore).toBeGreaterThanOrEqual(0.6);
  });
});

describe("http provider", () => {
  it("parses the documented envelope and applies the limit the API ignores", async () => {
    // Mirrors the observed upstream behaviour: limit is not honoured server-side.
    const pods = Array.from({ length: 100 }, (_, i) => ({
      id: `pod-${i}`,
      name: `Pod ${i}`,
      description: "body",
      privateSubnetId: "net-1",
      cumulativeUpVotesVolume: 1000 + i,
      cumulativeDownVotesVolume: 0,
    }));

    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ data: { pods } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    const items = await provider.listData("net-1", { limit: 5 });
    expect(items).toHaveLength(5);
  });

  it("surfaces the documented error envelope", async () => {
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "Rate limit exceeded" }), { status: 429 })) as unknown as typeof fetch,
    });

    await expect(provider.listDatanets()).rejects.toThrow(/429.*Rate limit exceeded/);
  });

  it("filters out pods belonging to a different datanet", async () => {
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            data: {
              pods: [
                { id: "a", name: "A", privateSubnetId: "net-1" },
                { id: "b", name: "B", privateSubnetId: "net-2" },
              ],
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    });

    const items = await provider.listData("net-1", { limit: 10 });
    expect(items.map((i) => i.id)).toEqual(["a"]);
  });
});

/**
 * Routes a fake fetch by path prefix and records what was asked for, so a test
 * can assert on the requests that were *not* made as well as the ones that were.
 */
function routedFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  // Longest route first, so `/me/subnets/priv-1` is not swallowed by `/me/subnets`.
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const impl = (async (url: string) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    calls.push(path);
    const key = keys.find((r) => path.includes(r));
    if (key === undefined) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    const body = routes[key];
    if (body instanceof Response) return body.clone();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const pod = (id: string, subnet: string | null, votes = 1000) => ({
  id,
  name: `Pod ${id}`,
  description: "body",
  privateSubnetId: subnet,
  cumulativeUpVotesVolume: votes,
  cumulativeDownVotesVolume: 0,
});

const subnet = (id: string, name: string) => ({
  id,
  subnetName: name,
  subnetDescription: "",
  upVoteVolume: 1000,
  downVoteVolume: 0,
});

describe("authenticated reads for permissioned datanets", () => {
  it("never touches the /me/* surface without a credential", async () => {
    const { impl, calls } = routedFetch({
      "/public/subnets": { data: { subnets: [subnet("net-1", "Public")] } },
      "/public/pods": { data: { pods: [pod("a", "net-1")] } },
    });
    const provider = new ReppoHttpProvider({ cacheTtlMs: 0, fetchImpl: impl });

    await provider.listDatanets();
    await provider.listData("net-1");
    await provider.searchData({ text: "x", limit: 5 });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.includes("/me/"))).toBe(false);
  });

  it("surfaces an owned datanet that the public listing does not carry", async () => {
    const { impl } = routedFetch({
      "/public/subnets": { data: { subnets: [subnet("pub-1", "Public one")] } },
      "/me/subnets": { data: { subnets: [subnet("priv-1", "Permissioned")] } },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    const ids = (await provider.listDatanets()).map((d) => d.id);
    expect(ids).toContain("priv-1");
    expect(ids).toContain("pub-1");
  });

  it("orders owned datanets first, so the limit cannot drop the only rows the credential reaches", async () => {
    const { impl } = routedFetch({
      "/public/subnets": {
        data: { subnets: [subnet("pub-1", "One"), subnet("pub-2", "Two")] },
      },
      "/me/subnets": { data: { subnets: [subnet("priv-1", "Permissioned")] } },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    const datanets = await provider.listDatanets({ limit: 2 });
    expect(datanets).toHaveLength(2);
    expect(datanets[0]!.id).toBe("priv-1");
  });

  it("does not report an owned datanet that fails the caller's search term", async () => {
    const { impl } = routedFetch({
      "/public/subnets": { data: { subnets: [] } },
      "/me/subnets": {
        data: { subnets: [subnet("priv-1", "Solana liquidity"), subnet("priv-2", "Robotics")] },
      },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    const ids = (await provider.listDatanets({ search: "robotics" })).map((d) => d.id);
    expect(ids).toEqual(["priv-2"]);
  });

  it("accepts the bare-array envelope the authenticated surface may return", async () => {
    // Unverified against a live account, so both documented shapes are allowed.
    const { impl } = routedFetch({
      "/public/subnets": { data: { subnets: [] } },
      "/me/subnets": { data: [subnet("priv-1", "Permissioned")] },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    expect((await provider.listDatanets()).map((d) => d.id)).toEqual(["priv-1"]);
  });

  it("resolves a datanet that 404s on the public surface", async () => {
    const { impl } = routedFetch({
      "/me/subnets/priv-1": { data: { subnet: subnet("priv-1", "Permissioned") } },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    const found = await provider.getDatanet("priv-1");
    expect(found?.id).toBe("priv-1");

    const anonymous = new ReppoHttpProvider({ cacheTtlMs: 0, fetchImpl: impl });
    expect(await anonymous.getDatanet("priv-1")).toBeNull();
  });

  it("merges owned pods into a datanet-scoped read without leaking another datanet's", async () => {
    const { impl } = routedFetch({
      "/public/pods": { data: { pods: [pod("public-a", "net-1")] } },
      "/me/pods": { data: { pods: [pod("mine-a", "net-1"), pod("mine-b", "net-2")] } },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    const ids = (await provider.listData("net-1", { limit: 10 })).map((i) => i.id);
    expect(ids).toContain("mine-a");
    expect(ids).toContain("public-a");
    expect(ids).not.toContain("mine-b");
  });

  it("does not return the same pod twice when it appears on both surfaces", async () => {
    const { impl } = routedFetch({
      "/public/pods": { data: { pods: [pod("shared", "net-1")] } },
      "/me/pods": { data: { pods: [pod("shared", "net-1")] } },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    expect(await provider.listData("net-1", { limit: 10 })).toHaveLength(1);
  });

  it("applies the search term to owned pods, which have no server-side search", async () => {
    const { impl } = routedFetch({
      "/public/pods": { data: { pods: [] } },
      "/me/pods": {
        data: {
          pods: [
            { ...pod("hit", "net-1"), name: "Liquidity report" },
            { ...pod("miss", "net-1"), name: "Robotics report" },
          ],
        },
      },
    });
    const provider = new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "session",
      fetchImpl: impl,
    });

    const ids = (await provider.searchData({ text: "liquidity", limit: 10 })).map((i) => i.id);
    expect(ids).toEqual(["hit"]);
  });
});

describe("rejected credentials", () => {
  const unauthorized = () =>
    new ReppoHttpProvider({
      cacheTtlMs: 0,
      privyToken: "stale",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch,
    });

  it("raises a distinct error rather than a generic upstream failure", async () => {
    await expect(unauthorized().listDatanets()).rejects.toBeInstanceOf(ReppoAuthError);
  });

  it("is not answered with recorded public fixtures", async () => {
    // The whole point of the distinction: degrading here would hand back the
    // public corpus dressed as the permissioned one.
    await expect(withFixtureFallback(unauthorized()).listDatanets()).rejects.toBeInstanceOf(
      ReppoAuthError,
    );
  });

  it("still degrades to fixtures when upstream is merely unreachable", async () => {
    const offline = new ReppoHttpProvider({
      cacheTtlMs: 0,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    const datanets = await withFixtureFallback(offline).listDatanets({ limit: 5 });
    expect(datanets.length).toBeGreaterThan(0);
  });
});
