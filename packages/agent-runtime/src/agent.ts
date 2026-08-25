import { z } from "zod";
import {
  ClaimKindSchema,
  claimFingerprint,
  RecommendationSchema,
  ResolutionCriteriaSchema,
  RiskSchema,
  UnitInterval,
  type Capability,
  type Evidence,
} from "@averis/types";
import { EvidenceCollector } from "./evidence";
import type { LLMMessage, LLMProvider, LLMToolResult, LLMUsage } from "./llm";
import { buildSystemPrompt, buildUserPrompt, type DatanetRubric } from "./prompt";
import type { AgentTool, ToolContext, ToolRegistry } from "./tools";
import type { DataProvider } from "@averis/types";

/**
 * What the model is asked to return.
 *
 * Deliberately *not* the full `StructuredIntelligence`: the model supplies
 * claims with `evidenceRefs`, and the runtime supplies the evidence array from
 * what the tools actually retrieved. The model is never trusted to author its
 * own provenance.
 */
export const ModelOutputSchema = z.object({
  summary: z.string().min(1),
  claims: z
    .array(
      z.object({
        statement: z.string().min(3),
        kind: ClaimKindSchema.default("ASSESSMENT"),
        confidence: UnitInterval,
        evidenceRefs: z.array(z.number().int().nonnegative()).default([]),
        resolution: ResolutionCriteriaSchema.optional(),
      }),
    )
    .min(1),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  recommendation: RecommendationSchema.nullable().default(null),
  risks: z.array(RiskSchema).default([]),
  confidence: UnitInterval,
});
export type ModelOutput = z.infer<typeof ModelOutputSchema>;

export interface ResolvedClaim {
  statement: string;
  kind: z.infer<typeof ClaimKindSchema>;
  confidence: number;
  fingerprint: string;
  evidence: Evidence[];
  resolution: z.infer<typeof ResolutionCriteriaSchema> | null;
  /** True when the model cited nothing that was actually retrieved. */
  unsupported: boolean;
}

export interface AgentRunResult {
  summary: string;
  confidence: number;
  claims: ResolvedClaim[];
  evidence: Evidence[];
  metrics: Record<string, number | string>;
  recommendation: z.infer<typeof RecommendationSchema> | null;
  risks: z.infer<typeof RiskSchema>[];
  usage: LLMUsage;
  toolCalls: Array<{ name: string; ok: boolean; ms: number }>;
  durationMs: number;
}

export interface AgentRunOptions {
  jobId: string;
  agentId: string;
  agentName: string;
  agentDescription: string;
  capabilities: Capability[];
  jobType: string;
  query: string;
  target: string | null;
  minimumConfidence: number | null;
  datanetIds: string[];
  /** Published standards of the datanets in scope, quoted to the agent. */
  rubrics?: DatanetRubric[];
  provider: LLMProvider;
  registry: ToolRegistry;
  /** The agent's tool allowlist. Anything outside it is unreachable. */
  allowedTools: string[];
  data: DataProvider;
  /** Hard cap on tool-gathering rounds, so a loop cannot run unbounded. */
  maxSteps?: number;
  signal?: AbortSignal;
  logger?: (message: string, detail?: Record<string, unknown>) => void;
}

export class AgentRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentRunError";
  }
}

/**
 * Runs one agent against one job and returns structured, evidence-linked
 * intelligence.
 *
 * The loop is provider-independent by construction: it only ever calls
 * `LLMProvider.complete`, so the same code path drives Anthropic, OpenAI,
 * Gemini or the deterministic mock.
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const started = Date.now();
  const maxSteps = options.maxSteps ?? 4;
  const logger = options.logger ?? (() => {});
  const evidence = new EvidenceCollector(`${options.jobId}:${options.agentId}`);

  const tools = options.registry.select(options.allowedTools);
  if (tools.length === 0) {
    throw new AgentRunError(
      `Agent "${options.agentName}" has no usable tools; it cannot gather evidence.`,
    );
  }

  const promptInputs = {
    agentName: options.agentName,
    agentDescription: options.agentDescription,
    capabilities: options.capabilities,
    jobType: options.jobType,
    query: options.query,
    target: options.target,
    minimumConfidence: options.minimumConfidence,
    toolNames: tools.map((t) => t.name),
    rubrics: options.rubrics ?? [],
  };

  const system = buildSystemPrompt(promptInputs);
  const messages: LLMMessage[] = [{ role: "user", content: buildUserPrompt(promptInputs) }];

  const context: ToolContext = {
    jobId: options.jobId,
    agentId: options.agentId,
    query: options.query,
    datanetIds: options.datanetIds,
    data: options.data,
    evidence,
    signal: options.signal ?? new AbortController().signal,
    logger,
  };

  const usage: LLMUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const toolCalls: AgentRunResult["toolCalls"] = [];

  const toolSpecs = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

  // ─── Evidence-gathering phase ─────────────────────────────────────────────
  for (let step = 0; step < maxSteps; step++) {
    if (context.signal.aborted) throw new AgentRunError("aborted before completion");

    const response = await options.provider.complete({
      system,
      messages,
      tools: toolSpecs,
      effort: "high",
    });
    accumulate(usage, response.usage);

    if (response.toolCalls.length === 0) break;

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });

    // Tool calls in one turn are independent; run them concurrently and return
    // every result together, including failures.
    const results = await Promise.all(
      response.toolCalls.map(async (call): Promise<LLMToolResult> => {
        const tool = tools.find((t) => t.name === call.name);
        const startedAt = Date.now();

        if (!tool) {
          toolCalls.push({ name: call.name, ok: false, ms: 0 });
          return {
            callId: call.id,
            name: call.name,
            content: `Tool "${call.name}" is not available to this agent.`,
            isError: true,
          };
        }

        try {
          const output = await (tool as AgentTool<unknown, unknown>).execute(call.input, context);
          toolCalls.push({ name: call.name, ok: true, ms: Date.now() - startedAt });
          return { callId: call.id, name: call.name, content: JSON.stringify(output) };
        } catch (error) {
          toolCalls.push({ name: call.name, ok: false, ms: Date.now() - startedAt });
          return {
            callId: call.id,
            name: call.name,
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      }),
    );

    messages.push({ role: "user", content: "", toolResults: results });
  }

  // ─── Structured answer phase ──────────────────────────────────────────────
  messages.push({
    role: "user",
    content:
      evidence.size === 0
        ? "No evidence was retrieved. Report that honestly with low confidence — do not speculate."
        : `You have collected ${evidence.size} pieces of evidence (refs 0..${evidence.size - 1}). Produce your final structured analysis now, citing refs on every claim.`,
  });

  const final = await options.provider.complete({
    system,
    messages,
    responseSchema: { name: "structured_intelligence", schema: ModelOutputSchema },
    effort: "high",
  });
  accumulate(usage, final.usage);

  const parsed = ModelOutputSchema.safeParse(final.structured ?? parseLoose(final.text));
  if (!parsed.success) {
    throw new AgentRunError(
      `Agent "${options.agentName}" returned output that does not satisfy the intelligence schema: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const claims: ResolvedClaim[] = parsed.data.claims.map((claim) => {
    const resolved = evidence.resolve(claim.evidenceRefs);
    return {
      statement: claim.statement.trim(),
      kind: claim.kind,
      confidence: claim.confidence,
      fingerprint: claimFingerprint(claim.statement),
      evidence: resolved,
      resolution: claim.resolution ?? null,
      // A claim that cited refs which do not exist is flagged rather than
      // dropped, so the evaluation engine can penalise the agent for it.
      unsupported: resolved.length === 0,
    };
  });

  logger("agent completed", {
    agent: options.agentName,
    claims: claims.length,
    evidence: evidence.size,
    unsupported: claims.filter((c) => c.unsupported).length,
  });

  return {
    summary: parsed.data.summary,
    confidence: parsed.data.confidence,
    claims,
    evidence: evidence.all(),
    metrics: parsed.data.metrics,
    recommendation: parsed.data.recommendation,
    risks: parsed.data.risks,
    usage,
    toolCalls,
    durationMs: Date.now() - started,
  };
}

function accumulate(target: LLMUsage, add: LLMUsage): void {
  target.inputTokens += add.inputTokens;
  target.outputTokens += add.outputTokens;
  target.costUsd += add.costUsd;
}

/** Last-resort recovery for providers without native structured output. */
function parseLoose(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
