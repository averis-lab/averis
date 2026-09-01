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

const RATES: Record<string, TokenRates> = {
  "gemini-3-pro": { inputPerMillion: 2, outputPerMillion: 12 },
  "gemini-2.5-pro": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
};

const DEFAULT_MODEL = "gemini-3-pro";
const FALLBACK_RATES: TokenRates = { inputPerMillion: 2, outputPerMillion: 12 };

export interface GeminiProviderConfig {
  apiKey?: string | undefined;
  model?: string | undefined;
  maxTokens?: number;
}

/** Google Gemini adapter over `@google/genai`. */
export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly maxTokens: number;
  private readonly apiKey: string | undefined;
  private client: unknown = null;

  constructor(config: GeminiProviderConfig = {}) {
    this.model = config.model || DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 16_000;
    this.apiKey = config.apiKey;
  }

  private async getClient() {
    if (this.client) return this.client as import("@google/genai").GoogleGenAI;
    const { GoogleGenAI } = await import("@google/genai");
    this.client = new GoogleGenAI(this.apiKey ? { apiKey: this.apiKey } : {});
    return this.client as import("@google/genai").GoogleGenAI;
  }

  async listModels(): Promise<LLMModelInfo[]> {
    const client = await this.getClient();
    const pager = await client.models.list();
    const models: LLMModelInfo[] = [];

    for await (const model of pager) {
      const actions = model.supportedActions ?? [];
      // Embedding and tuning models cannot hold a conversation; listing them
      // would offer the user a choice that silently fails at chat time.
      if (actions.length > 0 && !actions.includes("generateContent")) continue;

      const id = (model.name ?? "").replace(/^models\//, "");
      if (!id) continue;

      models.push({
        id,
        displayName: model.displayName || id,
        contextWindow: model.inputTokenLimit ?? null,
        description: model.description ?? undefined,
      });
    }
    return models;
  }

  async *stream(request: LLMRequest): AsyncGenerator<string, void, unknown> {
    const client = await this.getClient();
    const stream = await client.models.generateContentStream({
      model: this.model,
      contents: request.messages.map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      })),
      config: { systemInstruction: request.system, maxOutputTokens: this.maxTokens },
    });

    for await (const chunk of stream) {
      if (chunk.text) yield chunk.text;
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const client = await this.getClient();
    const rates = RATES[this.model] ?? FALLBACK_RATES;

    const contents = request.messages.map((message) => {
      if (message.toolResults?.length) {
        return {
          role: "user" as const,
          parts: message.toolResults.map((result) => ({
            functionResponse: {
              name: result.name,
              response: { output: result.content, error: result.isError ?? false },
            },
          })),
        };
      }
      if (message.toolCalls?.length) {
        return {
          role: "model" as const,
          parts: message.toolCalls.map((call) => ({
            functionCall: { name: call.name, args: call.input },
          })),
        };
      }
      return {
        role: message.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: message.content }],
      };
    });

    try {
      const response = await client.models.generateContent({
        model: this.model,
        contents,
        config: {
          systemInstruction: request.system,
          maxOutputTokens: this.maxTokens,
          ...(request.responseSchema
            ? {
                responseMimeType: "application/json",
                responseJsonSchema: z.toJSONSchema(request.responseSchema.schema, {
                  target: "draft-2020-12",
                  // What the model must send, not what parsing yields — and a
                  // schema that normalises a field on the way in cannot be
                  // rendered from the output side at all.
                  io: "input",
                }),
              }
            : {}),
          ...(request.tools?.length && !request.responseSchema
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      parametersJsonSchema: tool.inputSchema,
                    })),
                  },
                ],
              }
            : {}),
        },
      });

      const text = response.text ?? "";
      const toolCalls: LLMToolCall[] = (response.functionCalls ?? []).map((call, index) => ({
        id: call.id ?? `gemini-call-${index}`,
        name: call.name ?? "unknown",
        input: (call.args ?? {}) as Record<string, unknown>,
      }));

      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      return {
        text,
        toolCalls,
        ...(request.responseSchema ? { structured: safeParse(text) } : {}),
        usage: {
          inputTokens,
          outputTokens,
          costUsd: computeCost({ inputTokens, outputTokens }, rates),
        },
        stopReason: toolCalls.length > 0 ? "tool_use" : "end",
      };
    } catch (error) {
      throw new LLMError(
        this.name,
        error instanceof Error ? error.message : String(error),
        false,
      );
    }
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
