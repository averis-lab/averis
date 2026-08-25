import { describe, expect, it } from "vitest";
import {
  createToolRegistry,
  DEFAULT_TOOLS,
  EvidenceCollector,
  MockProvider,
  runAgent,
  createHttpTool,
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
