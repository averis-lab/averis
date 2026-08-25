import {
  DataQuerySchema,
  type DataItem,
  type DataProvider,
  type DataQuery,
  type Datanet,
} from "@averis/types";
import {
  PodEnvelope,
  PodListEnvelope,
  ReppoErrorEnvelope,
  SubnetEnvelope,
  SubnetListEnvelope,
} from "./schemas";
import { normalizePod, normalizeSubnet, REPPO_SOURCE } from "./normalize";

export interface ReppoHttpConfig {
  baseUrl?: string;
  timeoutMs?: number;
  /** In-memory response cache TTL. 0 disables caching. */
  cacheTtlMs?: number;
  /** Only required for authenticated /me/* endpoints, which reads never touch. */
  privyToken?: string | undefined;
  agentApiKey?: string | undefined;
  fetchImpl?: typeof fetch;
}

export class ReppoApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(`Reppo API ${status} on ${path}: ${message}`);
    this.name = "ReppoApiError";
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

/**
 * Live Reppo Platform API provider.
 *
 * The intelligence layer only reads. Every endpoint used here is under
 * `/public/*` and requires no authentication, which means the protocol can
 * consume curated Reppo data without custody of any user's Privy session.
 * Auth headers are wired up but only attach when a token is configured.
 */
export class ReppoHttpProvider implements DataProvider {
  readonly name = REPPO_SOURCE;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly fetchImpl: typeof fetch;
  private readonly privyToken: string | undefined;
  private readonly agentApiKey: string | undefined;

  constructor(config: ReppoHttpConfig = {}) {
    this.baseUrl = (config.baseUrl ?? "https://reppo.ai/api/v1").replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.cacheTtlMs = config.cacheTtlMs ?? 60_000;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    this.privyToken = config.privyToken;
    this.agentApiKey = config.agentApiKey;
  }

  async listDatanets(page?: { page?: number; limit?: number; search?: string }): Promise<Datanet[]> {
    const query = new URLSearchParams();
    query.set("page", String(page?.page ?? 1));
    query.set("limit", String(page?.limit ?? 25));
    if (page?.search) query.set("search", page.search);

    const body = await this.get(`/public/subnets?${query}`);
    const parsed = SubnetListEnvelope.safeParse(body);
    if (!parsed.success) return [];
    return parsed.data.data.subnets.map(normalizeSubnet);
  }

  async getDatanet(id: string): Promise<Datanet | null> {
    const body = await this.get(`/public/subnets/${encodeURIComponent(id)}`, { allow404: true });
    if (body === null) return null;

    const single = SubnetEnvelope.safeParse(body);
    if (single.success) return normalizeSubnet(single.data.data.subnet);

    // Some deployments return the single resource inside the list envelope.
    const list = SubnetListEnvelope.safeParse(body);
    const first = list.success ? list.data.data.subnets[0] : undefined;
    return first ? normalizeSubnet(first) : null;
  }

  async listData(
    datanetId: string,
    page?: { page?: number; limit?: number },
  ): Promise<DataItem[]> {
    const query = new URLSearchParams();
    query.set("page", String(page?.page ?? 1));
    query.set("limit", String(page?.limit ?? 25));
    query.set("filters[subnet]", datanetId);

    const body = await this.get(`/public/pods?${query}`);
    const parsed = PodListEnvelope.safeParse(body);
    if (!parsed.success) return [];

    // Two upstream behaviours are worked around here, both observed live:
    //  * `filters[subnet]` is advisory, so the datanet filter is re-applied
    //    locally — a datanet-scoped query must never leak evidence from a
    //    datanet the job did not select.
    //  * `limit` is not honoured on /public/pods (a limit=40 request returned
    //    3 240 rows), so it is enforced here rather than trusted.
    const limit = page?.limit ?? 25;
    return parsed.data.data.pods
      .map(normalizePod)
      .filter((item) => item.datanetId === null || item.datanetId === datanetId)
      .slice(0, limit);
  }

  async getData(dataId: string): Promise<DataItem | null> {
    const body = await this.get(`/public/pods/${encodeURIComponent(dataId)}`, { allow404: true });
    if (body === null) return null;

    const single = PodEnvelope.safeParse(body);
    if (single.success) return normalizePod(single.data.data.pod);

    const list = PodListEnvelope.safeParse(body);
    const first = list.success ? list.data.data.pods[0] : undefined;
    return first ? normalizePod(first) : null;
  }

  async searchData(query: DataQuery): Promise<DataItem[]> {
    const q = DataQuerySchema.parse(query);

    // Datanet-scoped search: page through each selected datanet, then rank.
    if (q.datanetIds && q.datanetIds.length > 0) {
      const perDatanet = Math.max(5, Math.ceil(q.limit / q.datanetIds.length) * 2);
      const batches = await Promise.all(
        q.datanetIds.map((id) =>
          this.listData(id, { page: q.page, limit: perDatanet }).catch(() => [] as DataItem[]),
        ),
      );
      return this.rank(batches.flat(), q);
    }

    const params = new URLSearchParams();
    params.set("page", String(q.page));
    params.set("limit", String(q.limit));
    if (q.text) params.set("search", q.text);

    const body = await this.get(`/public/pods?${params}`);
    const parsed = PodListEnvelope.safeParse(body);
    if (!parsed.success) return [];
    return this.rank(parsed.data.data.pods.map(normalizePod), q);
  }

  /** Quality floor first, then highest-curated first, then truncate. */
  private rank(items: DataItem[], q: { minQuality?: number; limit: number }): DataItem[] {
    const floor = q.minQuality ?? 0;
    const seen = new Set<string>();
    return items
      .filter((item) => {
        if (item.qualityScore < floor) return false;
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((a, b) => b.qualityScore - a.qualityScore)
      .slice(0, q.limit);
  }

  private async get(path: string, opts: { allow404?: boolean } = {}): Promise<unknown> {
    const cached = this.readCache(path);
    if (cached !== undefined) return cached;

    const headers: Record<string, string> = { accept: "application/json" };
    if (this.privyToken) headers["cookie"] = `privy-token=${this.privyToken}`;
    if (this.agentApiKey) headers["authorization"] = `Bearer ${this.agentApiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers,
        signal: controller.signal,
      });

      if (response.status === 404 && opts.allow404) return null;

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let message = text.slice(0, 200);
        try {
          const parsed = ReppoErrorEnvelope.safeParse(JSON.parse(text));
          if (parsed.success) message = parsed.data.error;
        } catch {
          // Non-JSON error body; the truncated text is the best we have.
        }
        throw new ReppoApiError(response.status, path, message || response.statusText);
      }

      const body: unknown = await response.json();
      this.writeCache(path, body);
      return body;
    } catch (error) {
      if (error instanceof ReppoApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ReppoApiError(408, path, `timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private readCache(key: string): unknown {
    if (this.cacheTtlMs <= 0) return undefined;
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  private writeCache(key: string, value: unknown): void {
    if (this.cacheTtlMs <= 0) return;
    this.cache.set(key, { expires: Date.now() + this.cacheTtlMs, value });
  }
}
