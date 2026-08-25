import type { DataProvider } from "@averis/types";
import { ReppoFixtureProvider } from "./fixture-provider";
import { ReppoHttpProvider, type ReppoHttpConfig } from "./http-provider";

export * from "./normalize";
export * from "./schemas";
export { ReppoHttpProvider, ReppoApiError, type ReppoHttpConfig } from "./http-provider";
export { ReppoFixtureProvider } from "./fixture-provider";

export type ReppoProviderKind = "http" | "fixture";

/**
 * Builds the data provider from environment configuration.
 *
 * The protocol core never calls this — it receives a `DataProvider`. Only the
 * composition root (api / workers / operator) picks an implementation, which
 * is what keeps the intelligence layer swappable across data networks.
 */
export function createReppoProvider(env: NodeJS.ProcessEnv = process.env): DataProvider {
  const kind = (env["REPPO_PROVIDER"] ?? "http").toLowerCase() as ReppoProviderKind;

  if (kind === "fixture") return new ReppoFixtureProvider();

  const config: ReppoHttpConfig = {
    baseUrl: env["REPPO_API_BASE_URL"] ?? "https://reppo.ai/api/v1",
    timeoutMs: Number(env["REPPO_TIMEOUT_MS"] ?? 20_000),
    cacheTtlMs: Number(env["REPPO_CACHE_TTL_MS"] ?? 60_000),
    privyToken: env["REPPO_PRIVY_TOKEN"] || undefined,
    agentApiKey: env["REPPO_AGENT_API_KEY"] || undefined,
  };
  return new ReppoHttpProvider(config);
}

/**
 * Wraps a provider so a transient upstream failure degrades to recorded
 * fixtures instead of failing the job. Evidence retrieved this way is marked
 * by the caller, never silently presented as live data.
 */
export function withFixtureFallback(primary: DataProvider): DataProvider {
  const fallback = new ReppoFixtureProvider();
  const guard = async <T>(run: () => Promise<T>, recover: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch {
      return recover();
    }
  };

  return {
    name: primary.name,
    listDatanets: (p) => guard(() => primary.listDatanets(p), () => fallback.listDatanets(p)),
    getDatanet: (id) => guard(() => primary.getDatanet(id), () => fallback.getDatanet(id)),
    listData: (id, p) => guard(() => primary.listData(id, p), () => fallback.listData(id, p)),
    getData: (id) => guard(() => primary.getData(id), () => fallback.getData(id)),
    searchData: (q) => guard(() => primary.searchData(q), () => fallback.searchData(q)),
  };
}
