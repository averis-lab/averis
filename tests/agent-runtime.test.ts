import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  DEFAULT_TOOLS,
  EvidenceCollector,
  MockProvider,
  providerIsConfigured,
  runAgent,
  createHttpTool,
  ModelOutputSchema,
} from "@averis/agent-runtime";
import { ReppoFixtureProvider } from "@averis/reppo-adapter";
import type { Capability, DataProvider } from "@averis/types";

const data = new ReppoFixtureProvider();
const registry = createToolRegistry();

function options(overrides: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return {
    jobId: "job-1",
    agentId: "agent-1",
    agentName: "Onchain Analyst",
    agentDescription: "You are an onchain and DeFi liquidity specialist.",
    capabilities: [{ domain: "defi", skill: "liquidity", declared: 0.9 }] as Capability[],
    jobType: "asset-analysis",
    query: "Assess the reliability of geopolitical risk signals in the curated corpus",
    target: null,
    minimumConfidence: null,
    datanetIds: [] as string[],
    provider: new MockProvider(),
    registry,
    allowedTools: [...DEFAULT_TOOLS],
    data: data as DataProvider,
    ...overrides,
  };
}

describe("evidence collector", () => {
  it("deduplicates identical evidence to one stable index", () => {
    const c = new EvidenceCollector("run-1");
    const a = c.record({ type: "REPPO_POD", source: "reppo://pod/x", content: "same" });
    const b = c.record({ type: "REPPO_POD", source: "reppo://pod/x", content: "same" });
    expect(a).toBe(b);
    expect(c.size).toBe(1);
  });

  it("refuses to resolve references that were never collected", () => {
    const c = new EvidenceCollector("run-1");
    c.record({ type: "WEB", source: "https://a.example", content: "one" });
    // 0 exists; 7 and -1 are fabricated.
    expect(c.resolve([0, 7, -1]).map((e) => e.source)).toEqual(["https://a.example"]);
  });

  it("reports zero reliability for a claim citing nothing", () => {
    expect(new EvidenceCollector("r").reliabilityOf([])).toBe(0);
  });
});

/**
 * A gateway that lost the structured-output parameter.
 *
 * This is what OpenRouter does with a model whose provider does not support
 * `response_format`: it forwards the call, drops the parameter, and returns
 * prose. Nothing errors. So the reply here carries the right object as fenced
 * text with `structured` absent — the exact shape the runtime has to survive.
 */
class ProseOnlyGateway extends MockProvider {
  readonly guaranteesStructuredOutput = false;
  /** Every request it was given, so the prompt can be inspected. */
  readonly seen: Array<{ system: string; messages: unknown[] }> = [];

  override async complete(request: Parameters<MockProvider["complete"]>[0]) {
    this.seen.push({ system: request.system, messages: request.messages });
    const answer = await super.complete(request);
    if (!answer.structured) return answer;
    const { structured, ...rest } = answer;
    return { ...rest, text: "Here is my analysis.\n\n```json\n" + JSON.stringify(structured) + "\n```" };
  }
}

/** The same thing, but honest about honouring the schema natively. */
class RecordingProvider extends MockProvider {
  readonly seen: Array<{ messages: unknown[] }> = [];

  override async complete(request: Parameters<MockProvider["complete"]>[0]) {
    this.seen.push({ messages: request.messages });
    return super.complete(request);
  }
}

const lastUserText = (seen: Array<{ messages: unknown[] }>): string => {
  const messages = seen[seen.length - 1]!.messages as Array<{ role: string; content: string }>;
  return [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
};

describe("what a real model actually returns", () => {
  it("accepts a claim that says it has no resolution criteria", () => {
    // `null` and an absent key mean the same thing here, and the runtime
    // stores null for both. Refusing one of them cost a whole agent's output
    // on the first run against real models.
    const parsed = ModelOutputSchema.safeParse({
      summary: "s",
      confidence: 0.5,
      claims: [{ statement: "a claim", confidence: 0.5, resolution: null }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.claims[0]?.resolution ?? null).toBeNull();
  });

  it("drops resolution criteria no clock could ever resolve", async () => {
    // `deadline` is typed as a string and a real model uses that latitude —
    // "2026-Q4", or a sentence. Carrying it through produced an Invalid Date
    // at insert time and failed the write for every claim in the output.
    class DatesInProse extends MockProvider {
      override async complete(request: Parameters<MockProvider["complete"]>[0]) {
        const answer = await super.complete(request);
        if (!answer.structured) return answer;
        const out = answer.structured as { claims: Array<Record<string, unknown>> };
        out.claims[0] = {
          ...out.claims[0],
          resolution: {
            metric: "win_rate",
            operator: "gte",
            threshold: 0.5,
            source: "the corpus",
            deadline: "when ETH data is ingested",
          },
        };
        return { ...answer, structured: out };
      }
    }

    const result = await runAgent(options({ provider: new DatesInProse() }));

    // The claim survives; only the criteria nothing could act on are gone.
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.claims[0]?.resolution).toBeNull();
  });

  it("keeps a non-scalar metric rather than discarding the analysis around it", () => {
    const parsed = ModelOutputSchema.safeParse({
      summary: "s",
      confidence: 0.5,
      claims: [{ statement: "a claim", confidence: 0.5 }],
      metrics: { refs: [0, 3, 7], ratio: 0.5, note: "n", flagged: true, missing: null },
    });
    expect(parsed.success).toBe(true);
    // Rendered to a scalar, so everything downstream sees what it always saw.
    expect(parsed.data?.metrics).toEqual({
      refs: "[0,3,7]",
      ratio: 0.5,
      note: "n",
      flagged: "true",
    });
  });
});

describe("structured output a gateway may have dropped", () => {
  it("says nothing extra to a provider that honours the schema natively", async () => {
    const provider = new RecordingProvider();
    await runAgent(options({ provider }));

    // The default is silence: an adapter bound to its own vendor's models is
    // not made to carry a schema the API already enforces.
    expect(lastUserText(provider.seen)).not.toContain("JSON Schema");
  });

  it("states the schema in the prompt when the provider cannot promise it", async () => {
    const provider = new ProseOnlyGateway();
    await runAgent(options({ provider }));

    const asked = lastUserText(provider.seen);
    expect(asked).toContain("JSON Schema");
    // The shape itself, not merely a mention of one.
    expect(asked).toContain("claims");
    expect(asked).toContain("evidenceRefs");
  });

  it("recovers a full result from prose, so a dropped parameter is not a failed job", async () => {
    const result = await runAgent(options({ provider: new ProseOnlyGateway() }));

    // Everything the merge needs survived the round trip through text.
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThan(0);
    // And the claims still cite evidence the runtime actually retrieved,
    // which is the property that must not be traded away for compatibility.
    expect(result.claims.some((claim) => claim.evidence.length > 0)).toBe(true);
  });
});

describe("runAgent", () => {
  it("produces evidence-linked structured intelligence from curated data", async () => {
    const result = await runAgent(options());

    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.summary).toBeTruthy();
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);

    // The protocol's central invariant: claims trace to real provenance.
    const supported = result.claims.filter((c) => !c.unsupported);
    expect(supported.length).toBeGreaterThan(0);
    for (const claim of supported) {
      expect(claim.evidence.length).toBeGreaterThan(0);
      for (const e of claim.evidence) {
        expect(e.source).toMatch(/^reppo:\/\/pod\//);
        expect(result.evidence.some((r) => r.id === e.id)).toBe(true);
      }
    }
  });

  it("records genuine upstream provenance, not model-authored sources", async () => {
    const result = await runAgent(options());
    const ids = new Set((await data.searchData({ limit: 200 })).map((i) => `reppo://pod/${i.id}`));
    for (const e of result.evidence) expect(ids.has(e.source)).toBe(true);
  });

  it("carries upstream curation quality through as evidence reliability", async () => {
    const result = await runAgent(options());
    for (const e of result.evidence) {
      expect(e.reliability).toBeGreaterThanOrEqual(0);
      expect(e.reliability).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic for the same agent and non-identical across agents", async () => {
    const a1 = await runAgent(options());
    const a2 = await runAgent(options());
    expect(a1.claims.map((c) => c.statement)).toEqual(a2.claims.map((c) => c.statement));

    const other = await runAgent(
      options({
        agentId: "agent-2",
        agentName: "Security Agent",
        agentDescription: "You are a security and integrity specialist.",
        capabilities: [{ domain: "security", skill: null, declared: 0.9 }],
      }),
    );
    expect(other.claims.map((c) => c.statement)).not.toEqual(a1.claims.map((c) => c.statement));

    // Cohorts must still overlap, or consensus would have nothing to merge.
    const shared = new Set(a1.claims.map((c) => c.fingerprint));
    const overlap = other.claims.filter((c) => shared.has(c.fingerprint));
    expect(overlap.length).toBeGreaterThan(0);
  });

  it("refuses to run an agent with no usable tools", async () => {
    await expect(runAgent(options({ allowedTools: [] }))).rejects.toThrow(/no usable tools/);
  });

  it("confines an agent to its tool allowlist", async () => {
    const result = await runAgent(options({ allowedTools: ["reppo_search_data"] }));
    for (const call of result.toolCalls) expect(call.name).toBe("reppo_search_data");
  });

  it("enforces the job's datanet scope over anything the model asks for", async () => {
    const [first] = await data.listDatanets({ limit: 1 });
    const result = await runAgent(options({ datanetIds: [first!.id] }));
    for (const e of result.evidence) {
      expect(e.metadata["datanetId"]).toBe(first!.id);
    }
  });
});

describe("http tool guardrails", () => {
  const tool = createHttpTool({ allowedHosts: ["example.com"] });
  const ctx = {
    jobId: "j",
    agentId: "a",
    query: "q",
    datanetIds: [],
    data: data as DataProvider,
    evidence: new EvidenceCollector("r"),
    signal: new AbortController().signal,
    logger: () => {},
  };

  it("rejects non-https URLs", async () => {
    await expect(tool.execute({ url: "http://example.com" }, ctx)).rejects.toThrow(/https/);
  });

  it("rejects hosts outside the allowlist", async () => {
    await expect(tool.execute({ url: "https://evil.test/x" }, ctx)).rejects.toThrow(/allowlist/);
  });

  it("refuses private address ranges", async () => {
    for (const host of ["https://127.0.0.1", "https://10.0.0.5", "https://192.168.1.1", "https://169.254.169.254"]) {
      await expect(tool.execute({ url: host }, ctx)).rejects.toThrow(/private address/);
    }
  });
});


/**
 * The gate the selector uses to drop an agent before a budget is reserved.
 *
 * It matters that this is exact rather than permissive: the reservation is
 * deliberately *kept* when work throws, so an agent admitted here without a
 * key spends a job's allowance to reach an error the runtime could have seen
 * coming.
 */
describe("providerIsConfigured", () => {
  it("always admits the deterministic provider", () => {
    expect(providerIsConfigured("mock", {})).toBe(true);
    expect(providerIsConfigured("MOCK", {})).toBe(true);
  });

  it("requires a key for each real provider", () => {
    expect(providerIsConfigured("anthropic", {})).toBe(false);
    expect(providerIsConfigured("anthropic", { ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(providerIsConfigured("anthropic", { ANTHROPIC_AUTH_TOKEN: "t" })).toBe(true);

    expect(providerIsConfigured("openai", {})).toBe(false);
    expect(providerIsConfigured("openai", { OPENAI_API_KEY: "k" })).toBe(true);

    expect(providerIsConfigured("gemini", {})).toBe(false);
    expect(providerIsConfigured("gemini", { GEMINI_API_KEY: "k" })).toBe(true);
    expect(providerIsConfigured("gemini", { GOOGLE_GENERATIVE_AI_API_KEY: "k" })).toBe(true);
  });

  it("does not admit a provider it cannot build", () => {
    // A typo in the registry must not reach execution: createLLMProvider
    // throws on an unknown name, and that throw would land after the reserve.
    expect(providerIsConfigured("anthropc", { ANTHROPIC_API_KEY: "k" })).toBe(false);
    expect(providerIsConfigured("", {})).toBe(false);
  });

  it("treats another provider's key as no key at all", () => {
    expect(providerIsConfigured("anthropic", { OPENAI_API_KEY: "k" })).toBe(false);
  });
});
