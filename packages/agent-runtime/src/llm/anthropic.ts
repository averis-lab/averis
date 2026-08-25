import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import {
  computeCost,
  LLMError,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMModelInfo,
  type LLMToolCall,
  type TokenRates,
} from "./types";

/** Published per-million-token rates, used for budget accounting. */
const RATES: Record<string, TokenRates> = {
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

const DEFAULT_MODEL = "claude-opus-5";

export interface AnthropicProviderConfig {
  apiKey?: string | undefined;
  model?: string | undefined;
  maxTokens?: number;
}

/**
 * Anthropic adapter, built on the official `@anthropic-ai/sdk`.
 *
 * The SDK is imported lazily so an operator running only the mock or OpenAI
 * provider never pays its startup cost.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly maxTokens: number;
  private readonly apiKey: string | undefined;
  private client: Anthropic | null = null;

  constructor(config: AnthropicProviderConfig = {}) {
    this.model = config.model || DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 16_000;
    this.apiKey = config.apiKey;
  }

  private async getClient(): Promise<Anthropic> {
    if (this.client) return this.client;
    const { default: Ctor } = await import("@anthropic-ai/sdk");
    // A bare constructor resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or a
    // configured CLI profile, so an explicit key stays optional.
    this.client = this.apiKey ? new Ctor({ apiKey: this.apiKey }) : new Ctor();
    return this.client;
  }

  async listModels(): Promise<LLMModelInfo[]> {
    const client = await this.getClient();
    try {
      const models: LLMModelInfo[] = [];
      // The SDK paginates; iterating walks every page.
      for await (const model of client.models.list({ limit: 100 })) {
        models.push({
          id: model.id,
          displayName: model.display_name || model.id,
          contextWindow: model.max_input_tokens ?? null,
        });
      }
      return models;
    } catch (error) {
      throw wrap(this.name, error);
    }
  }

  async *stream(request: LLMRequest): AsyncGenerator<string, void, unknown> {
    const client = await this.getClient();
    try {
      const stream = client.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        thinking: { type: "adaptive" },
        output_config: { effort: request.effort ?? "medium" },
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }
    } catch (error) {
      throw wrap(this.name, error);
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const client = await this.getClient();
    const rates = RATES[this.model] ?? RATES[DEFAULT_MODEL]!;

    const messages = request.messages.map((message) => {
      if (message.toolResults?.length) {
        return {
          role: "user" as const,
          content: message.toolResults.map((result) => ({
            type: "tool_result" as const,
            tool_use_id: result.callId,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })),
        };
      }
      if (message.toolCalls?.length) {
        return {
          role: "assistant" as const,
          content: [
            ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
            ...message.toolCalls.map((call) => ({
              type: "tool_use" as const,
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          ],
        };
      }
      return { role: message.role, content: message.content };
    });

    try {
      // Structured phase: ask for schema-conforming JSON, no tools.
      if (request.responseSchema) {
        const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
        const response = await client.messages.parse({
          model: this.model,
          max_tokens: this.maxTokens,
          system: request.system,
          messages,
          thinking: { type: "adaptive" },
          output_config: {
            effort: request.effort ?? "high",
            format: zodOutputFormat(
              request.responseSchema.schema as z.ZodType<Record<string, unknown>>,
            ),
          },
        });

        if (response.stop_reason === "refusal") {
          throw new LLMError(this.name, `refused: ${response.stop_details?.category}`, false);
        }

        return {
          text: textOf(response),
          toolCalls: [],
          structured: response.parsed_output ?? null,
          usage: usageOf(response, rates),
          stopReason: "end",
        };
      }

      // Tool phase: let the model gather evidence before it concludes.
      const response = await client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: request.system,
        messages,
        thinking: { type: "adaptive" },
        output_config: { effort: request.effort ?? "high" },
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool["input_schema"],
              })),
            }
          : {}),
      });

      const toolCalls: LLMToolCall[] = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        }));

      return {
        text: textOf(response),
        toolCalls,
        usage: usageOf(response, rates),
        stopReason: mapStop(response.stop_reason),
      };
    } catch (error) {
      throw wrap(this.name, error);
    }
  }
}

function textOf(response: { content: Array<{ type: string }> }): string {
  return response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function usageOf(
  response: { usage: { input_tokens: number; output_tokens: number } },
  rates: TokenRates,
) {
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  return { inputTokens, outputTokens, costUsd: computeCost({ inputTokens, outputTokens }, rates) };
}

function mapStop(reason: string | null): LLMResponse["stopReason"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "end_turn":
    case "stop_sequence":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function wrap(provider: string, error: unknown): LLMError {
  if (error instanceof LLMError) return error;
  const status = (error as { status?: number }).status;
  const retryable = status === 429 || status === 408 || (status !== undefined && status >= 500);
  return new LLMError(provider, error instanceof Error ? error.message : String(error), retryable);
}
