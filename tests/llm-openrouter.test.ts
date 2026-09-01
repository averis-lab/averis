import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * The `openai` SDK is replaced wholesale so the adapter can be exercised
 * without a network or a key. What is under test is not the SDK — it is the
 * two decisions this codebase layers on top of it: which endpoint a routed
 * provider talks to, and where a run's cost comes from.
 */
const create = vi.fn();
const constructed: Array<{ apiKey?: string; baseURL?: string }> = [];

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
    constructor(config: { apiKey?: string; baseURL?: string }) {
      constructed.push(config);
    }
  },
}));

const { createLLMProvider, providerIsConfigured, OpenRouterProvider } = await import(
  "@averis/agent-runtime"
);

function completion(usage: Record<string, unknown>) {
  return {
    choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
    usage,
  };
}

const request = { system: "s", messages: [{ role: "user" as const, content: "q" }] };

beforeEach(() => {
  create.mockReset();
  constructed.length = 0;
});

describe("openrouter provider", () => {
  it("is selected from the environment alone", () => {
    const provider = createLLMProvider(
      {},
      {
        LLM_PROVIDER: "openrouter",
        LLM_MODEL: "anthropic/claude-sonnet-5",
        OPENROUTER_API_KEY: "sk-or-test",
      } as NodeJS.ProcessEnv,
    );

    expect(provider.name).toBe("openrouter");
    expect(provider.model).toBe("anthropic/claude-sonnet-5");
  });

  it("gates on its own key, not another vendor's", () => {
    expect(providerIsConfigured("openrouter", {})).toBe(false);
    expect(providerIsConfigured("openrouter", { OPENAI_API_KEY: "k" })).toBe(false);
    expect(providerIsConfigured("openrouter", { OPENROUTER_API_KEY: "k" })).toBe(true);
  });

  it("does not promise structured output it cannot enforce", () => {
    // It routes to models it does not control, and drops parameters the chosen
    // one does not support rather than refusing. Saying so is what makes the
    // caller state the schema in the prompt as well.
    expect(new OpenRouterProvider({ apiKey: "k", model: "vendor/m" }).guaranteesStructuredOutput)
      .toBe(false);
  });

  it("refuses to build without a routed model", () => {
    // Guessing here would surface as a 400 from a third party, after the job
    // engine has already reserved the budget for the run.
    expect(() => new OpenRouterProvider({ apiKey: "k" })).toThrow(/no model set/i);
    expect(() => new OpenRouterProvider({ apiKey: "k", model: "  " })).toThrow(/no model set/i);
  });

  it("routes to the gateway rather than to OpenAI", async () => {
    create.mockResolvedValue(completion({ prompt_tokens: 10, completion_tokens: 5, cost: 0.02 }));

    const provider = createLLMProvider(
      { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
      { OPENROUTER_API_KEY: "sk-or-test" } as NodeJS.ProcessEnv,
    );
    await provider.complete(request);

    expect(constructed[0]?.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(constructed[0]?.apiKey).toBe("sk-or-test");
  });

  describe("the schema parameter, decided per model", () => {
    /** The catalogue OpenRouter publishes, trimmed to what the adapter reads. */
    const catalogue = (entries: Record<string, string[]>) =>
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: Object.entries(entries).map(([id, supported_parameters]) => ({
            id,
            supported_parameters,
          })),
        }),
      })) as unknown as typeof fetch;

    const schema = { name: "out", schema: z.object({ a: z.string() }) };

    beforeEach(() => {
      // The catalogue is cached per process; each case starts from cold.
      (OpenRouterProvider as unknown as { catalogue: unknown }).catalogue = null;
      create.mockResolvedValue(completion({ prompt_tokens: 1, completion_tokens: 1 }));
    });

    it("sends it to a model the catalogue says supports it", async () => {
      vi.stubGlobal("fetch", catalogue({ "vendor/capable": ["tools", "structured_outputs"] }));
      await new OpenRouterProvider({ apiKey: "k", model: "vendor/capable" })
        .complete({ ...request, responseSchema: schema });

      // Withholding it here would drop enforcement from a model that honours
      // it, which is how a cohort starts answering in prose.
      expect(create.mock.calls[0]![0]).toHaveProperty("response_format");
    });

    it("withholds it from a model the catalogue says cannot", async () => {
      vi.stubGlobal("fetch", catalogue({ "vendor/plain": ["tools"] }));
      await new OpenRouterProvider({ apiKey: "k", model: "vendor/plain" })
        .complete({ ...request, responseSchema: schema });

      // Liquid failed a real run with `Grammar error: Unimplemented keys:
      // ["propertyNames"]` — its decoder read the schema and refused it. The
      // prompt carries the shape for these models instead.
      expect(create.mock.calls[0]![0]).not.toHaveProperty("response_format");
    });

    it("withholds it when the catalogue cannot be read at all", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
      await new OpenRouterProvider({ apiKey: "k", model: "vendor/unknown" })
        .complete({ ...request, responseSchema: schema });

      // Fail closed: the prompt still carries the schema, so withholding costs
      // reliability while sending it to a model that cannot parse it costs the
      // whole call.
      expect(create.mock.calls[0]![0]).not.toHaveProperty("response_format");
    });
  });

  it("treats a 200 with no completion as a retryable gateway failure", async () => {
    // What an overloaded upstream actually returns through a gateway: HTTP 200,
    // an error object, and no `choices`. Indexing into that threw a TypeError
    // with no provider and no cause, and — carrying no HTTP status — was
    // recorded as permanent, losing the agent for the rest of the job.
    create.mockResolvedValue({ error: { message: "Upstream error from Nvidia: overloaded" } });
    const provider = new OpenRouterProvider({ apiKey: "k", model: "nvidia/some-model" });

    await expect(provider.complete(request)).rejects.toMatchObject({
      name: "LLMError",
      provider: "openrouter",
      retryable: true,
    });
    // The model and the upstream's own words, so the failure is diagnosable.
    await expect(provider.complete(request)).rejects.toThrow(/nvidia\/some-model/);
    await expect(provider.complete(request)).rejects.toThrow(/overloaded/);
  });

  it("still refuses an empty choices array", async () => {
    create.mockResolvedValue({ choices: [] });
    const provider = new OpenRouterProvider({ apiKey: "k", model: "vendor/m" });
    await expect(provider.complete(request)).rejects.toThrow(/no completion/);
  });

  it("reports the cost the gateway charged, not a rate card", async () => {
    create.mockResolvedValue(completion({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.0731 }));

    const provider = new OpenRouterProvider({ apiKey: "k", model: "anthropic/claude-sonnet-5" });
    const response = await provider.complete(request);

    expect(response.usage.costUsd).toBe(0.0731);
  });

  it("books nothing rather than inventing a figure when no cost is reported", async () => {
    // A routed model has no rate card here, so a plausible-looking number
    // would be fiction on a dashboard that says "measured".
    create.mockResolvedValue(completion({ prompt_tokens: 1000, completion_tokens: 500 }));

    const provider = new OpenRouterProvider({ apiKey: "k", model: "meta-llama/llama-3-8b:free" });
    const response = await provider.complete(request);

    expect(response.usage.costUsd).toBe(0);
    expect(response.usage.inputTokens).toBe(1000);
  });
});

describe("openai provider", () => {
  it("stays on OpenAI when no base url is set", async () => {
    create.mockResolvedValue(completion({ prompt_tokens: 10, completion_tokens: 5 }));

    const provider = createLLMProvider(
      { provider: "openai" },
      { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
    );
    await provider.complete(request);

    expect(constructed[0]?.baseURL).toBeUndefined();
  });

  it("reaches any compatible endpoint from the environment", async () => {
    create.mockResolvedValue(completion({ prompt_tokens: 10, completion_tokens: 5 }));

    const provider = createLLMProvider(
      { provider: "openai" },
      {
        OPENAI_API_KEY: "sk-test",
        OPENAI_BASE_URL: "http://localhost:11434/v1",
      } as NodeJS.ProcessEnv,
    );
    await provider.complete(request);

    expect(constructed[0]?.baseURL).toBe("http://localhost:11434/v1");
  });

  it("still prices from its rate card, which reports no cost of its own", async () => {
    create.mockResolvedValue(completion({ prompt_tokens: 1_000_000, completion_tokens: 0 }));

    const provider = createLLMProvider(
      { provider: "openai", model: "gpt-5-mini" },
      { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
    );
    const response = await provider.complete(request);

    expect(response.usage.costUsd).toBeCloseTo(0.25, 6);
  });
});
