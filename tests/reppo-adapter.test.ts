import { describe, expect, it } from "vitest";
import {
  ReppoFixtureProvider,
  ReppoHttpProvider,
  curationQuality,
  inferDomains,
  normalizePod,
  POD_SATURATION,
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
