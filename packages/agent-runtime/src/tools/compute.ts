import { ToolError, type AgentTool } from "./types";

/**
 * Deterministic statistics over already-collected evidence.
 *
 * Models are unreliable at arithmetic and there is no reason to let them do it
 * here — the numbers that end up in claims should come from code, over the
 * exact rows the tool runtime recorded.
 */
export const computeStats: AgentTool<{ refs?: number[]; field?: string }, unknown> = {
  name: "compute_evidence_stats",
  description:
    "Compute exact statistics (count, mean, median, min, max, sum) over the reliability of collected evidence. Use this instead of estimating numbers yourself.",
  inputSchema: {
    type: "object",
    properties: {
      refs: {
        type: "array",
        items: { type: "integer", minimum: 0 },
        description: "Evidence refs to include. Omit to use every collected item.",
      },
      field: {
        type: "string",
        enum: ["reliability", "upVotes", "downVotes", "approvalRate"],
        default: "reliability",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, context) {
    const all = context.evidence.all();
    const selected =
      input.refs && input.refs.length > 0 ? context.evidence.resolve(input.refs) : all;

    if (selected.length === 0) {
      throw new ToolError(this.name, "no evidence has been collected yet");
    }

    const field = input.field ?? "reliability";
    const values = selected.map((item) => {
      if (field === "reliability") return item.reliability;
      const raw = item.metadata[field];
      return typeof raw === "number" ? raw : 0;
    });

    const sorted = [...values].sort((a, b) => a - b);
    const total = values.reduce((a, b) => a + b, 0);
    const mid = Math.floor(sorted.length / 2);

    return {
      field,
      count: values.length,
      sum: total,
      mean: total / values.length,
      median:
        sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
    };
  },
};
