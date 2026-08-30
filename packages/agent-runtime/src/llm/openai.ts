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
  "gpt-5.1": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5": { inputPerMillion: 1.25, outputPerMillion: 10 },
  "gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
};

const DEFAULT_MODEL = "gpt-5.1";
const FALLBACK_RATES: TokenRates = { inputPerMillion: 1.25, outputPerMillion: 10 };

export interface OpenAIProviderConfig {
  apiKey?: string | undefined;
  model?: string | undefined;
  baseURL?: string | undefined;
  maxTokens?: number;
  /**
   * Vendor identifier reported by the adapter. An OpenAI-compatible gateway is
   * not OpenAI: it must say its own name, because that name is what the agent
   * registry stores, what `providerIsConfigured` is asked about, and what an
   * `LLMError` is attributed to.
   */
  name?: string | undefined;
  /**
   * Per-model rate card, used only when the endpoint does not report what a
   * call actually cost. Overridable because the rates below are OpenAI's, and
   * a gateway in front of another vendor does not charge them.
   */
  rates?: Record<string, TokenRates> | undefined;
  /** Rate used for a model absent from `rates`. */
  fallbackRates?: TokenRates | undefined;
}

/**
 * OpenAI adapter over the Chat Completions surface.
 *
 * `baseURL` is configurable so any OpenAI-compatible endpoint — including a
 * locally hosted model — works through this same adapter. That is the cheapest
 * path to the "local models later" requirement.
 */
export class OpenAIProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  /**
   * Undefined here, which the contract reads as "yes": this adapter pointed at
   * OpenAI is pointed at models whose API enforces the schema. A subclass that
   * routes elsewhere overrides it — see `OpenRouterProvider`.
   */
  readonly guaranteesStructuredOutput?: boolean;
  private readonly maxTokens: number;
  private readonly config: OpenAIProviderConfig;
  private readonly rates: Record<string, TokenRates>;
  private readonly fallbackRates: TokenRates;
  private client: unknown = null;

  constructor(config: OpenAIProviderConfig = {}) {
    this.name = config.name || "openai";
    this.model = config.model || DEFAULT_MODEL;
    this.maxTokens = config.maxTokens ?? 16_000;
    this.rates = config.rates ?? RATES;
    this.fallbackRates = config.fallbackRates ?? FALLBACK_RATES;
    this.config = config;
  }

  private async getClient() {
    if (this.client) return this.client as import("openai").default;
    const { default: Ctor } = await import("openai");
    this.client = new Ctor({
      ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
      ...(this.config.baseURL ? { baseURL: this.config.baseURL } : {}),
    });
    return this.client as import("openai").default;
  }

  async listModels(): Promise<LLMModelInfo[]> {
    const client = await this.getClient();
    const models: LLMModelInfo[] = [];
    for await (const model of client.models.list()) {
      models.push({ id: model.id, displayName: model.id, contextWindow: null });
    }
    return models;
  }

  async *stream(request: LLMRequest): AsyncGenerator<string, void, unknown> {
    const client = await this.getClient();
    const stream = await client.chat.completions.create({
      model: this.model,
      max_completion_tokens: this.maxTokens,
      stream: true,
      messages: [
        { role: "system", content: request.system },
        ...request.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }

  /**
   * Whether `response_format` may be sent for the model this instance is bound
   * to.
   *
   * Asked per call rather than read from a flag because a gateway's answer
   * depends on the model, not on the adapter. Bound to one vendor's own API
   * the answer is simply yes; `OpenRouterProvider` overrides it.
   */
  protected async structuredOutputSupported(): Promise<boolean> {
    return this.guaranteesStructuredOutput !== false;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const client = await this.getClient();
    const rates = this.rates[this.model] ?? this.fallbackRates;

    type ChatMessage = Parameters<
      typeof client.chat.completions.create
    >[0]["messages"][number];

    const messages: ChatMessage[] = [{ role: "system", content: request.system }];

    for (const message of request.messages) {
      if (message.toolResults?.length) {
        for (const result of message.toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: result.callId,
            content: result.content,
          });
        }
        continue;
      }
      if (message.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: message.content || null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          })),
        });
        continue;
      }
      messages.push({ role: message.role, content: message.content });
    }

    try {
      const response = await client.chat.completions.create({
        model: this.model,
        max_completion_tokens: this.maxTokens,
        messages,
        ...(request.tools?.length && !request.responseSchema
          ? {
              tools: request.tools.map((tool) => ({
                type: "function" as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }
          : {}),
        /**
         * Only where it is certain to be understood.
         *
         * A gateway has three behaviours, not two. It may honour the schema,
         * it may drop it silently — and it may hand it to a provider whose
         * constrained-decoding engine parses it, meets a keyword it has not
         * implemented, and fails the whole call. Liquid rejects the
         * `propertyNames` that zod emits for a record type; nothing about
         * that is visible until it happens.
         *
         * So a provider that cannot promise native support does not get the
         * parameter at all. It is told the shape in the prompt instead, which
         * every model understands, and the reply is recovered from the text.
         */
        ...(request.responseSchema && (await this.structuredOutputSupported())
          ? {
              response_format: {
                type: "json_schema" as const,
                json_schema: {
                  name: request.responseSchema.name,
                  strict: false,
                  // See the note in `agent.ts`: what the model must send is
                  // the input side of the schema, not what parsing yields.
                  schema: z.toJSONSchema(request.responseSchema.schema, {
                    target: "draft-2020-12",
                    io: "input",
                  }) as Record<string, unknown>,
                },
              },
            }
          : {}),
      });

      /**
       * A 200 does not guarantee a completion.
       *
       * A gateway routing to somebody else's model answers `{ error: … }` with
       * no `choices` at all when that provider is overloaded, refuses, or drops
       * the request mid-route. Indexing into it threw a TypeError that named no
       * provider and no cause, was carried into the generic catch below, and —
       * having no HTTP status — was recorded as permanent. So an agent was lost
       * for the rest of the job over a hiccup that would have succeeded on the
       * next attempt.
       */
      const choices: unknown = (response as { choices?: unknown }).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        const reported = (response as { error?: { message?: unknown } }).error?.message;
        throw new LLMError(
          this.name,
          typeof reported === "string" && reported.trim().length > 0
            ? `${this.model} returned no completion: ${reported}`
            : `${this.model} returned no completion`,
          true,
        );
      }

      const choice = response.choices[0];
      if (!choice) throw new LLMError(this.name, "empty completion", true);

      const text = choice.message.content ?? "";
      const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? [])
        .filter((call): call is typeof call & { function: { name: string; arguments: string } } =>
          "function" in call,
        )
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          input: safeParse(call.function.arguments),
        }));

      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;

      /**
       * A cost the endpoint reports is the one that was actually charged, so
       * it always wins over the rate card. OpenAI itself reports no such
       * field and falls through to `rates`; a gateway that bills per call —
       * OpenRouter returns `usage.cost` on every response — is measured
       * rather than estimated, which is the only way the budget figures on
       * the dashboard mean what they say.
       *
       * Guarded on `> 0` as well as finiteness: a zero here is indistinguishable
       * from an endpoint that omits the field, and silently reporting free
       * inference would let a job spend without ever touching its budget.
       */
      const reported = (response.usage as { cost?: unknown } | undefined)?.cost;
      const measuredCost =
        typeof reported === "number" && Number.isFinite(reported) && reported > 0
          ? reported
          : null;

      return {
        text,
        toolCalls,
        ...(request.responseSchema ? { structured: safeParse(text) } : {}),
        usage: {
          inputTokens,
          outputTokens,
          costUsd: measuredCost ?? computeCost({ inputTokens, outputTokens }, rates),
        },
        stopReason:
          choice.finish_reason === "tool_calls"
            ? "tool_use"
            : choice.finish_reason === "length"
              ? "max_tokens"
              : "end",
      };
    } catch (error) {
      if (error instanceof LLMError) throw error;
      const status = (error as { status?: number }).status;
      throw new LLMError(
        this.name,
        error instanceof Error ? error.message : String(error),
        status === 429 || (status !== undefined && status >= 500),
      );
    }
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
