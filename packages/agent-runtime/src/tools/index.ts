import { computeStats } from "./compute";
import { createHttpTool, type HttpToolConfig } from "./http";
import { reppoGetDatanetData, reppoListDatanets, reppoSearchData } from "./reppo";
import { ToolRegistry, type AgentTool } from "./types";

export * from "./types";
export { reppoListDatanets, reppoSearchData, reppoGetDatanetData } from "./reppo";
export { computeStats } from "./compute";
export { createHttpTool, type HttpToolConfig } from "./http";

/** Tools every agent may use unless its allowlist says otherwise. */
export const DEFAULT_TOOLS = [
  "reppo_list_datanets",
  "reppo_search_data",
  "reppo_get_datanet_data",
  "compute_evidence_stats",
] as const;

export interface RegistryOptions {
  /** Omit to leave `http_get` unregistered — the safe default. */
  http?: HttpToolConfig;
  extra?: AgentTool<never, unknown>[];
}

export function createToolRegistry(options: RegistryOptions = {}): ToolRegistry {
  const registry = new ToolRegistry()
    .register(reppoListDatanets as AgentTool<never, unknown>)
    .register(reppoSearchData as AgentTool<never, unknown>)
    .register(reppoGetDatanetData as AgentTool<never, unknown>)
    .register(computeStats as AgentTool<never, unknown>);

  if (options.http && options.http.allowedHosts.length > 0) {
    registry.register(createHttpTool(options.http) as AgentTool<never, unknown>);
  }
  for (const tool of options.extra ?? []) registry.register(tool);

  return registry;
}
