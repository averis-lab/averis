import type { DataItem } from "@averis/types";
import { ToolError, type AgentTool, type ToolContext } from "./types";

/**
 * Rows handed back to the model.
 *
 * `ref` is the evidence index the model must cite. Returning it alongside the
 * content is what lets a claim be linked to provenance without the model ever
 * inventing an identifier.
 */
interface EvidenceRow {
  ref: number;
  title: string;
  source: string;
  quality: number;
  content: string;
  publishedAt: string | null;
  metadata: { upVotes: number; downVotes: number; approvalRate: number; datanetId: string | null };
}

function toRow(item: DataItem, context: ToolContext): EvidenceRow {
  const source = `reppo://pod/${item.id}`;
  const ref = context.evidence.record({
    type: "REPPO_POD",
    source,
    title: item.title,
    content: item.content,
    // Reliability is the upstream stake-backed curation score, not the
    // agent's opinion of the source.
    reliability: item.qualityScore,
    metadata: {
      datanetId: item.datanetId,
      url: item.url,
      upVotes: item.curation.upVotes,
      downVotes: item.curation.downVotes,
      approvalRate: item.curation.approvalRate,
      epoch: item.curation.epoch,
      author: item.author,
    },
    ...(item.publishedAt ? { timestamp: item.publishedAt } : {}),
  });

  return {
    ref,
    title: item.title,
    source,
    quality: Number(item.qualityScore.toFixed(4)),
    content: item.content.slice(0, 1_200),
    publishedAt: item.publishedAt ? item.publishedAt.toISOString() : null,
    metadata: {
      upVotes: item.curation.upVotes,
      downVotes: item.curation.downVotes,
      approvalRate: Number(item.curation.approvalRate.toFixed(4)),
      datanetId: item.datanetId,
    },
  };
}

export const reppoListDatanets: AgentTool<{ search?: string; limit?: number }, unknown> = {
  name: "reppo_list_datanets",
  description:
    "List curated datasets (Datanets) available upstream, with their domains and curation health. Use this first when the job is not already scoped to specific datanets.",
  inputSchema: {
    type: "object",
    properties: {
      search: { type: "string", description: "Optional free-text filter over datanet names." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, context) {
    try {
      const datanets = await context.data.listDatanets({
        limit: input.limit ?? 15,
        ...(input.search ? { search: input.search } : {}),
      });

      const scoped =
        context.datanetIds.length > 0
          ? datanets.filter((d) => context.datanetIds.includes(d.id))
          : datanets;

      context.logger("reppo_list_datanets", { returned: scoped.length });

      return {
        datanets: scoped.map((d) => ({
          id: d.id,
          name: d.name,
          description: d.description.slice(0, 400),
          domains: d.domains,
          approvalRate: Number(d.curation.approvalRate.toFixed(4)),
          status: d.curation.status,
        })),
      };
    } catch (error) {
      throw new ToolError(this.name, error instanceof Error ? error.message : String(error));
    }
  },
};

export const reppoSearchData: AgentTool<
  { query?: string; datanetIds?: string[]; minQuality?: number; limit?: number },
  unknown
> = {
  name: "reppo_search_data",
  description:
    "Search curated data items across Datanets and register them as citable evidence. Every returned row includes a `ref` index that MUST be used to link claims to evidence.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text search. Defaults to the job query." },
      datanetIds: {
        type: "array",
        items: { type: "string" },
        description: "Restrict to these datanets. Defaults to the job's scoped datanets.",
      },
      minQuality: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Drop items whose curation quality is below this floor.",
      },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, context) {
    try {
      // The job's datanet scope wins over anything the model proposes, so a
      // model cannot widen its own data access.
      const datanetIds =
        context.datanetIds.length > 0 ? context.datanetIds : (input.datanetIds ?? []);

      const items = await context.data.searchData({
        text: input.query || context.query,
        limit: input.limit ?? 15,
        ...(datanetIds.length > 0 ? { datanetIds } : {}),
        ...(input.minQuality !== undefined ? { minQuality: input.minQuality } : {}),
      });

      context.logger("reppo_search_data", { returned: items.length });

      return { items: items.map((item) => toRow(item, context)) };
    } catch (error) {
      throw new ToolError(this.name, error instanceof Error ? error.message : String(error));
    }
  },
};

export const reppoGetDatanetData: AgentTool<
  { datanetId: string; limit?: number },
  unknown
> = {
  name: "reppo_get_datanet_data",
  description:
    "Retrieve the highest-curated items from one specific Datanet and register them as citable evidence.",
  inputSchema: {
    type: "object",
    properties: {
      datanetId: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
    },
    required: ["datanetId"],
    additionalProperties: false,
  },
  async execute(input, context) {
    if (context.datanetIds.length > 0 && !context.datanetIds.includes(input.datanetId)) {
      throw new ToolError(this.name, `datanet "${input.datanetId}" is outside this job's scope`);
    }
    try {
      const items = await context.data.listData(input.datanetId, { limit: input.limit ?? 15 });
      context.logger("reppo_get_datanet_data", {
        datanetId: input.datanetId,
        returned: items.length,
      });
      return { items: items.map((item) => toRow(item, context)) };
    } catch (error) {
      throw new ToolError(this.name, error instanceof Error ? error.message : String(error));
    }
  },
};
