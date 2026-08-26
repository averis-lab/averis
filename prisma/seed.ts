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

  for (const spec of AGENTS) {
    const agent = await prisma.agent.upsert({
      where: { name: spec.name },
      create: {
        name: spec.name,
        description: spec.description,
        ownerId: owner.id,
        // `||`, not `??`: .env ships LLM_MODEL as an empty string, which `??`
        // passes straight through and leaves every agent with a blank model.
        modelProvider: process.env["LLM_PROVIDER"] || "mock",
        modelName: process.env["LLM_MODEL"] || "mock-analyst",
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
        modelProvider: process.env["LLM_PROVIDER"] || "mock",
        modelName: process.env["LLM_MODEL"] || "mock-analyst",
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
}

main()
  .catch((error: unknown) => {
    console.error("seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => void disconnect());
