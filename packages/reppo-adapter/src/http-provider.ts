import {
  DataQuerySchema,
  type DataItem,
  type DataProvider,
  type DataQuery,
  type Datanet,
} from "@averis/types";
import {
  MePodListEnvelope,
  MeSubnetListEnvelope,
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
  /**
   * Privy session cookie. This is what the documented `/me/*` surface
   * authenticates with, so it is what makes a permissioned datanet readable.
   */
  privyToken?: string | undefined;
  /** Agent bearer token, for deployments that issue one of those instead. */
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

/**
 * A credential was supplied and upstream rejected it.
 *
 * Kept distinct from every other upstream failure because the remedy is
 * different. A 500 or a timeout is worth retrying, and degrading to recorded
 * fixtures is a reasonable answer to one. A 401 is not an outage: it means the
 * configured identity cannot see what was asked for, and answering it with
 * recorded *public* fixtures would present them as the permissioned corpus.
 * That is the one substitution this layer must never make silently.
 */
export class ReppoAuthError extends ReppoApiError {
  constructor(status: number, path: string, message: string) {
    super(status, path, message);
    this.name = "ReppoAuthError";
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

/** First occurrence of each id wins, so callers order by precedence. */
function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * Live Reppo Platform API provider.
 *
 * The intelligence layer only ever reads. Without a credential it reads the
 * `/public/*` surface alone, which needs no authentication and no custody of
 * anyone's session — that remains the default and the whole behaviour of the
 * reference deployment.
 *
 * When a credential *is* configured the documented `/me/*` reads are merged in
 * on top, which is what brings permissioned datanets into range: `/public/subnets`
 * lists only active datanets, so one that is unpublished or access-gated is
 * absent there and reachable nowhere else.
 *
 * The reach of that has a documented edge, and it is worth stating plainly
 * rather than discovering later. `/me/*` is scoped to the *identity*, not to a
 * datanet: it returns the datanets that identity owns and the pods it created.
 * There is no documented read for "every pod in datanet X" on a datanet the
 * credential does not own, so a permissioned datanet is readable to the extent
 * that the configured identity owns it — not in general.
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

  /**
   * Whether the authenticated surface is in play at all.
   *
   * Every `/me/*` request in this class is behind this check, so a deployment
   * with no credential makes exactly the requests it made before this existed.
   */
  private get authenticated(): boolean {
    return Boolean(this.privyToken || this.agentApiKey);
  }

  async listDatanets(page?: { page?: number; limit?: number; search?: string }): Promise<Datanet[]> {
    const limit = page?.limit ?? 25;
    const query = new URLSearchParams();
    query.set("page", String(page?.page ?? 1));
    query.set("limit", String(limit));
    if (page?.search) query.set("search", page.search);

    const body = await this.get(`/public/subnets?${query}`);
    const parsed = SubnetListEnvelope.safeParse(body);
    const publicNets = parsed.success ? parsed.data.data.subnets.map(normalizeSubnet) : [];

    if (!this.authenticated) return publicNets;

    // Owned datanets lead rather than trail, and the ordering is the point:
    // they exist nowhere else in this response, so appending them after a full
    // page of public results would let the limit silently drop the only rows
    // the credential was configured to reach.
    const owned = await this.listOwnedDatanets(page);

    // `/me/subnets` has no documented `search`, so the caller's term is
    // applied locally rather than dropped — a searched listing that quietly
    // ignored the term for owned datanets would over-report them.
    const search = page?.search?.toLowerCase();
    const matched = search
      ? owned.filter((d) => `${d.name} ${d.description}`.toLowerCase().includes(search))
      : owned;

    return dedupeById([...matched, ...publicNets]).slice(0, limit);
  }

  async getDatanet(id: string): Promise<Datanet | null> {
    const body = await this.get(`/public/subnets/${encodeURIComponent(id)}`, { allow404: true });
    if (body !== null) {
      const single = SubnetEnvelope.safeParse(body);
      if (single.success) return normalizeSubnet(single.data.data.subnet);

      // Some deployments return the single resource inside the list envelope.
      const list = SubnetListEnvelope.safeParse(body);
      const first = list.success ? list.data.data.subnets[0] : undefined;
      if (first) return normalizeSubnet(first);
    }

    // Absent from the public surface is not the same as absent: a permissioned
    // datanet 404s there and resolves here.
    if (!this.authenticated) return null;

    const mine = await this.get(`/me/subnets/${encodeURIComponent(id)}`, { allow404: true });
    if (mine === null) return null;

    const single = SubnetEnvelope.safeParse(mine);
    if (single.success) return normalizeSubnet(single.data.data.subnet);

    const list = MeSubnetListEnvelope.safeParse(mine);
    const first = list.success ? list.data.data[0] : undefined;
    return first ? normalizeSubnet(first) : null;
  }

  async listData(
    datanetId: string,
    page?: { page?: number; limit?: number },
  ): Promise<DataItem[]> {
    const limit = page?.limit ?? 25;
    const query = new URLSearchParams();
    query.set("page", String(page?.page ?? 1));
    query.set("limit", String(limit));
    query.set("filters[subnet]", datanetId);

    const body = await this.get(`/public/pods?${query}`);
    const parsed = PodListEnvelope.safeParse(body);
    const publicPods = parsed.success ? parsed.data.data.pods.map(normalizePod) : [];

    const owned = this.authenticated ? await this.listOwnedData(page) : [];

    // Two upstream behaviours are worked around here, both observed live:
    //  * `filters[subnet]` is advisory, so the datanet filter is re-applied
    //    locally — a datanet-scoped query must never leak evidence from a
    //    datanet the job did not select. The same filter is what scopes the
    //    owned pods, since `/me/pods` returns them across every datanet at once.
    //  * `limit` is not honoured on /public/pods (a limit=40 request returned
    //    3 240 rows), so it is enforced here rather than trusted.
    return dedupeById([...owned, ...publicPods])
      .filter((item) => item.datanetId === null || item.datanetId === datanetId)
      .slice(0, limit);
  }

  async getData(dataId: string): Promise<DataItem | null> {
    const body = await this.get(`/public/pods/${encodeURIComponent(dataId)}`, { allow404: true });
    if (body !== null) {
      const single = PodEnvelope.safeParse(body);
      if (single.success) return normalizePod(single.data.data.pod);

      const list = PodListEnvelope.safeParse(body);
      const first = list.success ? list.data.data.pods[0] : undefined;
      if (first) return normalizePod(first);
    }

    if (!this.authenticated) return null;

    const mine = await this.get(`/me/pods/${encodeURIComponent(dataId)}`, { allow404: true });
    if (mine === null) return null;

    const single = PodEnvelope.safeParse(mine);
    if (single.success) return normalizePod(single.data.data.pod);

    const list = MePodListEnvelope.safeParse(mine);
    const first = list.success ? list.data.data[0] : undefined;
    return first ? normalizePod(first) : null;
  }

  async searchData(query: DataQuery): Promise<DataItem[]> {
    const q = DataQuerySchema.parse(query);

    // Datanet-scoped search: page through each selected datanet, then rank.
    // `listData` already merges the owned pods for each one.
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
    const publicPods = parsed.success ? parsed.data.data.pods.map(normalizePod) : [];

    if (!this.authenticated) return this.rank(publicPods, q);

    // `/me/pods` has no documented server-side search either, so the term is
    // applied locally. Without this an owned corpus would be reachable only by
    // id or by naming its datanet explicitly.
    const owned = await this.listOwnedData({ page: q.page, limit: q.limit });
    const text = q.text?.toLowerCase();
    const matched = text
      ? owned.filter((i) => `${i.title} ${i.content}`.toLowerCase().includes(text))
      : owned;

    return this.rank([...matched, ...publicPods], q);
  }

  /** Datanets owned by the authenticated identity, including unpublished ones. */
  private async listOwnedDatanets(page?: { page?: number; limit?: number }): Promise<Datanet[]> {
    const query = new URLSearchParams();
    query.set("page", String(page?.page ?? 1));
    query.set("limit", String(page?.limit ?? 25));

    const body = await this.get(`/me/subnets?${query}`);
    const parsed = MeSubnetListEnvelope.safeParse(body);
    return parsed.success ? parsed.data.data.map(normalizeSubnet) : [];
  }

  /**
   * Pods created by the authenticated identity, across every datanet at once.
   *
   * What these rows are is worth being precise about, because it bounds the
   * feature: they are the pods this identity created, which is a subset of a
   * permissioned datanet rather than all of it. An unminted draft also carries
   * no curation votes, so it lands on the neutral 0.5 prior — it does not
   * arrive weighted as good evidence merely because it is private.
   */
  private async listOwnedData(page?: { page?: number; limit?: number }): Promise<DataItem[]> {
    const query = new URLSearchParams();
    query.set("page", String(page?.page ?? 1));
    query.set("limit", String(page?.limit ?? 25));

    const body = await this.get(`/me/pods?${query}`);
    const parsed = MePodListEnvelope.safeParse(body);
    return parsed.success ? parsed.data.data.map(normalizePod) : [];
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
        message = message || response.statusText;

        if (response.status === 401 || response.status === 403) {
          throw new ReppoAuthError(response.status, path, message);
        }
        throw new ReppoApiError(response.status, path, message);
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

  /**
   * Cache keys are paths, which is safe because a provider instance holds one
   * credential for its whole life: public and `/me/*` paths never collide, and
   * two identities never share an instance.
   */
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
