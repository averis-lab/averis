import type { DataProvider } from "@averis/types";
import type { EvidenceCollector } from "../evidence";

/** Everything a tool is allowed to touch. Nothing else is in scope. */
export interface ToolContext {
  jobId: string;
  agentId: string;
  /** The job's natural-language question, for tools that need it. */
  query: string;
  /** Datanets the job is scoped to; empty means discovery is unrestricted. */
  datanetIds: string[];
  /** The upstream data network. Tools never construct their own. */
  data: DataProvider;
  /** Where retrieved material is registered as provenance. */
  evidence: EvidenceCollector;
  /** Aborts in-flight work when the job deadline passes. */
  signal: AbortSignal;
  logger: (message: string, detail?: Record<string, unknown>) => void;
}

export interface AgentTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  /** JSON Schema for the tool input, handed to the model verbatim. */
  inputSchema: Record<string, unknown>;
  execute(input: Input, context: ToolContext): Promise<Output>;
}

export class ToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
  ) {
    super(`Tool "${tool}" failed: ${message}`);
    this.name = "ToolError";
  }
}

/**
 * Tool registry with an explicit allowlist per agent.
 *
 * An agent receives only the tools it declared in the registry. This is the
 * least-privilege boundary from the security section of the design: an agent
 * that never declared network access cannot acquire it at runtime.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<never, unknown>>();

  register(tool: AgentTool<never, unknown>): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): AgentTool<never, unknown> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Returns only the requested tools that are actually registered. */
  select(allowed: string[]): AgentTool<never, unknown>[] {
    return allowed
      .map((name) => this.tools.get(name))
      .filter((tool): tool is AgentTool<never, unknown> => tool !== undefined);
  }
}
