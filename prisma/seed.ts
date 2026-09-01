import "@averis/db/env";
import { prisma, disconnect } from "@averis/db";

/**
 * Seeds the agent registry.
 *
 * Agents are deliberately specialized and only partly overlapping. A cohort of
 * near-identical agents produces correlated errors and unanimous "consensus"
 * that means nothing; the selector's diversity bonus only has something to
 * work with if the registry is genuinely varied.
 *
 * Every agent runs on the `mock` provider by default so the reference demo
 * works with no API keys. Point an agent at a real provider by updating its
 * `modelProvider` / `modelName`, which is a registry change, not a code change.
 *
 * `LLM_PROVIDER` / `LLM_MODEL` set that binding for the whole registry, and
 * `LLM_AGENT_MODELS` overrides it per agent — see `agentOverrides` below.
 */
const AGENTS = [
  {
    name: "Onchain Analyst",
    description:
      "You are an onchain analyst specializing in EVM chains, DeFi mechanics, token flows and liquidity structure.",
    capabilities: [
      { domain: "crypto", skill: null, declared: 0.9 },
      { domain: "defi", skill: "liquidity-analysis", declared: 0.92 },
      { domain: "evm", skill: null, declared: 0.88 },
    ],
    tools: ["reppo_list_datanets", "reppo_search_data", "reppo_get_datanet_data", "compute_evidence_stats"],
    pricePerJob: 0.5,
  },
  {
    name: "Research Agent",
    description:
      "You are a research analyst specializing in web research, document analysis and dataset evaluation.",
    capabilities: [
      { domain: "research", skill: "dataset-analysis", declared: 0.9 },
      { domain: "markets", skill: null, declared: 0.75 },
      { domain: "general", skill: null, declared: 0.8 },
    ],
    tools: ["reppo_list_datanets", "reppo_search_data", "reppo_get_datanet_data", "compute_evidence_stats"],
    pricePerJob: 0.4,
  },
  {
    name: "Security Agent",
    description:
      "You are a security analyst specializing in smart contract analysis, vulnerability detection and data integrity.",
    capabilities: [
      { domain: "security", skill: "vulnerability-detection", declared: 0.93 },
      { domain: "crypto", skill: null, declared: 0.7 },
      { domain: "defi", skill: "risk", declared: 0.8 },
    ],
    tools: ["reppo_search_data", "reppo_get_datanet_data", "compute_evidence_stats"],
    pricePerJob: 0.6,
  },
  {
    name: "Markets Agent",
    description:
      "You are a markets analyst specializing in price behaviour, volatility, prediction markets and macro context.",
    capabilities: [
      { domain: "markets", skill: "forecasting", declared: 0.87 },
      { domain: "geopolitics", skill: null, declared: 0.72 },
      { domain: "crypto", skill: null, declared: 0.68 },
    ],
    tools: ["reppo_list_datanets", "reppo_search_data", "compute_evidence_stats"],
    pricePerJob: 0.45,
  },
  {
    name: "Data Quality Agent",
    description:
      "You are a data quality analyst specializing in dataset integrity, curation health and provenance verification.",
    capabilities: [
      { domain: "research", skill: "data-quality", declared: 0.91 },
      { domain: "ai", skill: "model-evaluation", declared: 0.78 },
      { domain: "robotics", skill: null, declared: 0.6 },
    ],
    tools: ["reppo_list_datanets", "reppo_search_data", "reppo_get_datanet_data", "compute_evidence_stats"],
    pricePerJob: 0.35,
  },
];

/** Provider names `createLLMProvider` will accept; anything else is a model. */
const PROVIDER_KINDS = new Set(["anthropic", "openai", "openrouter", "gemini", "mock"]);

interface Binding {
  provider: string;
  model: string;
}

/**
 * Per-agent model bindings, read from `LLM_AGENT_MODELS`.
 *
 *   LLM_AGENT_MODELS=Markets Agent=anthropic/claude-sonnet-5,Research Agent=openai/gpt-5.1
 *
 * This exists for one reason. A cohort whose agents all run the same model
 * agrees with itself for reasons that have nothing to do with the evidence,
 * and this protocol reports agreement as a result. Letting the registry span
 * vendors is what makes a unanimous verdict worth reading — and through a
 * gateway like OpenRouter it costs one credential rather than three.
 *
 * An entry may name a provider explicitly as `provider:model`. The split is
 * only taken when the left side is a provider this codebase knows, because
 * model ids carry colons of their own — `…/llama-3-8b-instruct:free` is one
 * model, not the `…/llama-3-8b-instruct` provider.
 */
function agentOverrides(raw: string | undefined, fallback: Binding): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  if (!raw?.trim()) return bindings;

  for (const entry of raw.split(",")) {
    const separator = entry.indexOf("=");
    if (separator < 0) {
      // A bare model id here is the likely mistake, not a malformed pair: this
      // variable overrides one named agent, and the thing someone reaching for
      // it usually wants is the registry-wide default. Say which one that is,
      // or the warning only tells them they are wrong.
      console.warn(
        `LLM_AGENT_MODELS: ignoring "${entry.trim()}" — expected "Agent Name=model". ` +
          `To run every agent on one model, set LLM_MODEL=${entry.trim()} instead.`,
      );
      continue;
    }

    const name = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    if (!name || !value) {
      console.warn(`LLM_AGENT_MODELS: ignoring "${entry.trim()}" — empty name or model.`);
      continue;
    }

    const colon = value.indexOf(":");
    const head = colon > 0 ? value.slice(0, colon) : "";
    bindings.set(
      name,
      PROVIDER_KINDS.has(head)
        ? { provider: head, model: value.slice(colon + 1) }
        : { provider: fallback.provider, model: value },
    );
  }

  return bindings;
}

async function main(): Promise<void> {
  const owner = await prisma.user.upsert({
    where: { handle: "protocol" },
    create: { handle: "protocol", email: "protocol@averis.local" },
    update: {},
  });

  const dataSource = await prisma.dataSource.upsert({
    where: { name: "reppo" },
    create: {
      name: "reppo",
      kind: "REPPO",
      baseUrl: process.env["REPPO_API_BASE_URL"] ?? "https://reppo.ai/api/v1",
      config: { readsOnly: true, publicEndpointsOnly: true },
    },
    update: {},
  });

  // `||`, not `??`: .env ships LLM_MODEL as an empty string, which `??` passes
  // straight through and leaves every agent with a blank model.
  const registryDefault: Binding = {
    provider: process.env["LLM_PROVIDER"] || "mock",
    model: process.env["LLM_MODEL"] || "mock-analyst",
  };
  const overrides = agentOverrides(process.env["LLM_AGENT_MODELS"], registryDefault);

  for (const name of overrides.keys()) {
    if (!AGENTS.some((spec) => spec.name === name)) {
      console.warn(`LLM_AGENT_MODELS: no agent named "${name}" in the registry — entry ignored.`);
    }
  }

  for (const spec of AGENTS) {
    const binding = overrides.get(spec.name) ?? registryDefault;

    const agent = await prisma.agent.upsert({
      where: { name: spec.name },
      create: {
        name: spec.name,
        description: spec.description,
        ownerId: owner.id,
        modelProvider: binding.provider,
        modelName: binding.model,
        tools: spec.tools,
        pricePerJob: spec.pricePerJob.toFixed(6),
        maxConcurrent: 3,
      },
      // The update path must carry the runtime binding too, or re-seeding
      // after changing LLM_PROVIDER silently leaves existing agents on the old
      // one.
      update: {
        description: spec.description,
        tools: spec.tools,
        modelProvider: binding.provider,
        modelName: binding.model,
      },
      select: { id: true },
    });

    for (const capability of spec.capabilities) {
      // `skill` is nullable and part of the natural key, and Prisma cannot
      // address a compound unique key through a NULL column — so the row is
      // located explicitly rather than upserted on (agentId, domain, skill).
      const existing = await prisma.agentCapability.findFirst({
        where: { agentId: agent.id, domain: capability.domain, skill: capability.skill },
        select: { id: true },
      });

      if (existing) {
        await prisma.agentCapability.update({
          where: { id: existing.id },
          data: { declared: capability.declared },
        });
      } else {
        await prisma.agentCapability.create({ data: { agentId: agent.id, ...capability } });
      }
    }
  }

  const counts = {
    users: await prisma.user.count(),
    dataSources: await prisma.dataSource.count(),
    agents: await prisma.agent.count(),
    capabilities: await prisma.agentCapability.count(),
  };

  console.log("Seeded registry:", counts, `(data source: ${dataSource.name})`);

  // The binding decides which model produced every claim in the system, and it
  // is the one thing here that is invisible in the UI until a job has already
  // run on it. Printed so a misconfigured .env is caught at seed time.
  const bound = await prisma.agent.findMany({
    select: { name: true, modelProvider: true, modelName: true },
    orderBy: { name: "asc" },
  });
  for (const agent of bound) {
    console.log(`  ${agent.name.padEnd(20)} ${agent.modelProvider}:${agent.modelName}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error("seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => void disconnect());
