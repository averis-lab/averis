import type { z } from "zod";

/**
 * The protocol's only view of a language model.
 *
 * Nothing above this interface knows which vendor is answering. Adding a
 * provider means writing one more `LLMProvider`; it never means touching the
 * job engine, the agent loop, consensus or reputation.
 */
export interface LLMProvider {
  /** Vendor identifier: "anthropic" | "openai" | "gemini" | "mock" | … */
  readonly name: string;
  /** Concrete model this instance is bound to. */
  readonly model: string;
  complete(request: LLMRequest): Promise<LLMResponse>;

  /**
   * Models this credential can actually reach.
   *
   * Optional because a provider may not expose a catalogue. Where it does,
   * listing doubles as credential validation: a bad key fails here, before
   * the user has invested anything in a conversation.
   */
  listModels?(): Promise<LLMModelInfo[]>;

  /**
   * Yields text deltas as they arrive.
   *
   * Optional; callers fall back to `complete` when a provider omits it.
   */
  stream?(request: LLMRequest): AsyncGenerator<string, void, unknown>;
}

export interface LLMModelInfo {
  id: string;
  displayName: string;
  /** Maximum input context in tokens, when the provider reports it. */
  contextWindow: number | null;
  description?: string | undefined;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
  /** Present on assistant turns that requested tools. */
  toolCalls?: LLMToolCall[];
  /** Present on user turns that carry tool results. */
  toolResults?: LLMToolResult[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LLMToolResult {
  callId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/** Provider-neutral tool declaration. Adapters translate to vendor shapes. */
export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema draft-2020-12 object schema. */
  inputSchema: Record<string, unknown>;
}

export interface LLMRequest {
  system: string;
  messages: LLMMessage[];
  tools?: LLMToolSpec[];
  maxTokens?: number;
  /**
   * When set, the provider must return JSON conforming to this schema.
   * Providers that support native structured output use it; the rest fall
   * back to schema-in-prompt plus a parse-and-repair pass.
   */
  responseSchema?: { name: string; schema: z.ZodType } | undefined;
  /**
   * Reasoning depth hint, mapped onto each vendor's own control
   * (Anthropic `output_config.effort`, OpenAI `reasoning.effort`, …).
   */
  effort?: "low" | "medium" | "high";
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cost in USD, computed from the provider's published rates. */
  costUsd: number;
}

export interface LLMResponse {
  text: string;
  toolCalls: LLMToolCall[];
  /** Populated when the request carried a `responseSchema`. */
  structured?: unknown;
  usage: LLMUsage;
  stopReason: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
}

export class LLMError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "LLMError";
  }
}

export const NO_USAGE: LLMUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Per-million-token rates, used for budget accounting. */
export interface TokenRates {
  inputPerMillion: number;
  outputPerMillion: number;
}

export function computeCost(
  usage: { inputTokens: number; outputTokens: number },
  rates: TokenRates,
): number {
  return (
    (usage.inputTokens / 1_000_000) * rates.inputPerMillion +
    (usage.outputTokens / 1_000_000) * rates.outputPerMillion
  );
}
