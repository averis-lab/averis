import {
  DataQuerySchema,
  type DataItem,
  type DataProvider,
  type DataQuery,
  type Datanet,
} from "@averis/types";
import { PodListEnvelope, SubnetListEnvelope } from "./schemas";
import { normalizePod, normalizeSubnet, REPPO_SOURCE } from "./normalize";
import podFixtures from "../fixtures/pods.json" with { type: "json" };
import subnetFixtures from "../fixtures/subnets.json" with { type: "json" };

/**
 * Offline provider backed by responses recorded from the live Reppo API.
 *
 * This is not a mock with invented data — the fixtures are genuine payloads,
 * so schema drift in the adapter fails the tests rather than passing against
 * a fiction. It also lets the end-to-end demo run air-gapped and lets CI
 * exercise the whole pipeline without depending on a third-party service.
 */
export class ReppoFixtureProvider implements DataProvider {
  readonly name = REPPO_SOURCE;

  private readonly datanets: Datanet[];
  private readonly items: DataItem[];

  constructor(overrides?: { datanets?: Datanet[]; items?: DataItem[] }) {
    this.datanets =
      overrides?.datanets ??
      SubnetListEnvelope.parse(subnetFixtures).data.subnets.map(normalizeSubnet);
    this.items =
      overrides?.items ?? PodListEnvelope.parse(podFixtures).data.pods.map(normalizePod);
  }

  async listDatanets(page?: { page?: number; limit?: number; search?: string }): Promise<Datanet[]> {
    const limit = page?.limit ?? 25;
    const offset = ((page?.page ?? 1) - 1) * limit;
    const search = page?.search?.toLowerCase();

    const matching = search
      ? this.datanets.filter(
          (d) =>
            d.name.toLowerCase().includes(search) || d.description.toLowerCase().includes(search),
        )
      : this.datanets;

    return matching.slice(offset, offset + limit);
  }

  async getDatanet(id: string): Promise<Datanet | null> {
    return this.datanets.find((d) => d.id === id) ?? null;
  }

  async listData(datanetId: string, page?: { page?: number; limit?: number }): Promise<DataItem[]> {
    const limit = page?.limit ?? 25;
    const offset = ((page?.page ?? 1) - 1) * limit;
    return this.items
      .filter((item) => item.datanetId === datanetId)
      .sort((a, b) => b.qualityScore - a.qualityScore)
      .slice(offset, offset + limit);
  }

  async getData(dataId: string): Promise<DataItem | null> {
    return this.items.find((item) => item.id === dataId) ?? null;
  }

  async searchData(query: DataQuery): Promise<DataItem[]> {
    const q = DataQuerySchema.parse(query);
    const text = q.text?.toLowerCase().trim();
    const terms = text ? text.split(/\s+/).filter((t) => t.length > 2) : [];

    let pool = this.items;

    if (q.datanetIds && q.datanetIds.length > 0) {
      const allowed = new Set(q.datanetIds);
      pool = pool.filter((item) => item.datanetId !== null && allowed.has(item.datanetId));
    }

    if (q.domains && q.domains.length > 0) {
      const wanted = new Set(q.domains);
      const matchingNets = new Set(
        this.datanets.filter((d) => d.domains.some((x) => wanted.has(x))).map((d) => d.id),
      );
      pool = pool.filter((item) => item.datanetId !== null && matchingNets.has(item.datanetId));
    }

    if (q.minQuality !== undefined) {
      pool = pool.filter((item) => item.qualityScore >= q.minQuality!);
    }

    const scored = pool.map((item) => {
      const haystack = `${item.title} ${item.content}`.toLowerCase();
      const hits = terms.filter((t) => haystack.includes(t)).length;
      const relevance = terms.length === 0 ? 0 : hits / terms.length;
      // Relevance dominates; curation quality breaks ties among equal matches.
      return { item, score: relevance * 2 + item.qualityScore };
    });

    return scored
      .filter((s) => terms.length === 0 || s.score > s.item.qualityScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, q.limit)
      .map((s) => s.item);
  }
}
