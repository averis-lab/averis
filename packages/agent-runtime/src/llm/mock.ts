import {
  type LLMModelInfo,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMToolCall,
} from "./types";

/**
 * Deterministic analyst used for the reference demo, CI and offline runs.
 *
 * This is not a stub that returns canned prose. It reads the evidence the tool
 * runtime actually retrieved and derives every claim from real numbers in that
 * evidence — corpus size, curation vote volumes, approval rates, recency. That
 * matters because the pieces under test are the coordination mechanics
 * (evidence linkage, evaluation, weighting, consensus, disagreement surfacing),
 * and those only mean something when the inputs genuinely differ.
 *
 * Variation across agents comes from a seed derived from the agent persona, so
 * a cohort produces overlapping-but-distinct results: some claims agree (and
 * merge), some conflict (and surface as disagreements), and confidences differ
 * enough that the weighting strategy has real work to do. Runs are fully
 * reproducible for the same cohort.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly model: string;

  constructor(model = "mock-analyst") {
    this.model = model;
  }

  async listModels(): Promise<LLMModelInfo[]> {
    return [
      {
        id: "mock-analyst",
        displayName: "Mock Analyst (no API key required)",
        contextWindow: 32_000,
        description:
          "Deterministic local responder. Useful for trying the interface before connecting a real provider.",
      },
    ];
  }

  /**
   * Emits a canned reply word by word so the chat interface can be exercised —
   * including its streaming path — without any credential.
   */
  async *stream(request: LLMRequest): AsyncGenerator<string, void, unknown> {
    const last = [...request.messages].reverse().find((m) => m.role === "user");
    const question = (last?.content ?? "").trim();

    const reply =
      question.length === 0
        ? "Ask me something and I will echo the shape of a real answer."
        : `This is the mock provider, so there is no model behind this reply. You asked: "${truncate(question, 160)}". Connect a provider in Settings to get a real answer — the same chat will then run against your chosen model.`;

    for (const word of reply.split(" ")) {
      yield `${word} `;
      await new Promise((resolve) => setTimeout(resolve, 18));
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const seed = hashString(request.system);
    const rand = mulberry32(seed);

    const evidence = collectEvidence(request);
    const alreadyGathered = evidence.length > 0;

    // Tool phase — request evidence before concluding anything.
    if (!request.responseSchema) {
      if (!alreadyGathered && request.tools?.length) {
        const searchTool =
          request.tools.find((t) => t.name === "reppo_search_data") ?? request.tools[0]!;
        const call: LLMToolCall = {
          id: `mock-call-${seed.toString(16)}`,
          name: searchTool.name,
          input:
            searchTool.name === "reppo_search_data"
              ? { query: extractQuery(request), limit: 12 }
              : {},
        };
        return {
          text: "Gathering curated evidence before forming any conclusion.",
          toolCalls: [call],
          usage: { inputTokens: 420, outputTokens: 40, costUsd: 0 },
          stopReason: "tool_use",
        };
      }
      return {
        text: `Reviewed ${evidence.length} curated items.`,
        toolCalls: [],
        usage: { inputTokens: 900, outputTokens: 80, costUsd: 0 },
        stopReason: "end",
      };
    }

    // Structured phase — derive the result from the retrieved evidence.
    const structured = synthesize(evidence, extractQuery(request), personaOf(request), rand);

    return {
      text: "",
      toolCalls: [],
      structured,
      usage: { inputTokens: 1_600, outputTokens: 620, costUsd: 0 },
      stopReason: "end",
    };
  }
}

// ─── Evidence extraction ────────────────────────────────────────────────────

interface EvidenceRow {
  index: number;
  title: string;
  source: string;
  quality: number;
  upVotes: number;
  downVotes: number;
  approvalRate: number;
  publishedAt: string | null;
  content: string;
}

function collectEvidence(request: LLMRequest): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const message of request.messages) {
    for (const result of message.toolResults ?? []) {
      if (result.isError) continue;
      try {
        const parsed: unknown = JSON.parse(result.content);
        const items = Array.isArray(parsed)
          ? parsed
          : ((parsed as { items?: unknown[] })?.items ?? []);
        for (const item of items) {
          const row = item as Partial<EvidenceRow> & {
            metadata?: { upVotes?: number; downVotes?: number; approvalRate?: number };
          };
          rows.push({
            index: rows.length,
            title: String(row.title ?? "untitled"),
            source: String(row.source ?? ""),
            quality: Number(row.quality ?? 0.5),
            upVotes: Number(row.metadata?.upVotes ?? 0),
            downVotes: Number(row.metadata?.downVotes ?? 0),
            approvalRate: Number(row.metadata?.approvalRate ?? 0.5),
            publishedAt: row.publishedAt ? String(row.publishedAt) : null,
            content: String(row.content ?? ""),
          });
        }
      } catch {
        // A non-JSON tool result carries no structured evidence; skip it.
      }
    }
  }
  return rows;
}

function extractQuery(request: LLMRequest): string {
  const first = request.messages.find((m) => m.role === "user" && m.content);
  return first?.content.slice(0, 400) ?? "the requested subject";
}

/** Persona is carried in the system prompt; it seeds the agent's slant. */
function personaOf(request: LLMRequest): string {
  const match = /You are ([^.\n]+)/i.exec(request.system);
  return match?.[1]?.trim() ?? "an analyst";
}

// ─── Synthesis ──────────────────────────────────────────────────────────────

interface MockClaim {
  statement: string;
  kind: "FACT" | "ASSESSMENT" | "PREDICTION" | "RISK" | "RECOMMENDATION";
  confidence: number;
  evidenceRefs: number[];
  resolution?: Record<string, unknown>;
}

function synthesize(
  evidence: EvidenceRow[],
  query: string,
  persona: string,
  rand: () => number,
): Record<string, unknown> {
  if (evidence.length === 0) {
    return {
      summary: `No curated evidence could be retrieved for "${truncate(query, 120)}". No defensible conclusion is available.`,
      claims: [
        {
          statement: "The available curated corpus is empty, so no claim can be evidenced.",
          kind: "FACT",
          confidence: 0.95,
          evidenceRefs: [],
        },
      ],
      metrics: { evidenceCount: 0 },
      recommendation: null,
      risks: [
        {
          description: "Zero evidence retrieved; any downstream conclusion would be unfounded.",
          severity: "HIGH",
          likelihood: 1,
        },
      ],
      confidence: 0.1,
    };
  }

  const ranked = [...evidence].sort((a, b) => b.quality - a.quality);
  const totalUp = sum(evidence.map((e) => e.upVotes));
  const totalDown = sum(evidence.map((e) => e.downVotes));
  const meanQuality = sum(evidence.map((e) => e.quality)) / evidence.length;
  const approval = totalUp + totalDown > 0 ? totalUp / (totalUp + totalDown) : 0.5;
  const strong = evidence.filter((e) => e.quality >= 0.65);
  const weak = evidence.filter((e) => e.quality < 0.45);
  const recent = evidence.filter((e) => withinDays(e.publishedAt, 7));
  const top = ranked[0]!;

  // Shared claim pool: every agent draws from the same evidence-derived facts,
  // which is what gives consensus genuine agreement to detect.
  const pool: MockClaim[] = [
    {
      statement: `The curated corpus contains ${evidence.length} items with a mean curation quality of ${meanQuality.toFixed(2)}.`,
      kind: "FACT",
      confidence: 0.94,
      evidenceRefs: ranked.slice(0, 3).map((e) => e.index),
    },
    {
      statement: `Aggregate curation sentiment is ${(approval * 100).toFixed(1)}% approval across ${formatVolume(totalUp + totalDown)} of stake-weighted vote volume.`,
      kind: "FACT",
      confidence: 0.9,
      evidenceRefs: ranked.slice(0, 4).map((e) => e.index),
    },
    {
      statement: `"${truncate(top.title, 90)}" carries the highest curation conviction in the corpus at ${formatVolume(top.upVotes)} up-vote volume.`,
      kind: "FACT",
      confidence: 0.88,
      evidenceRefs: [top.index],
    },
    // Stance claim. An agent takes one side of this, never both — see below.
    {
      statement: stanceStatement(approval >= 0.75 ? "corroborated" : "contested"),
      kind: "ASSESSMENT",
      confidence: 0.6 + rand() * 0.2,
      evidenceRefs: ranked.slice(0, 5).map((e) => e.index),
    },
    {
      statement: `${strong.length} of ${evidence.length} items clear a 0.65 quality bar, giving a high-conviction subset of ${((strong.length / evidence.length) * 100).toFixed(0)}%.`,
      kind: "ASSESSMENT",
      confidence: 0.72 + rand() * 0.15,
      evidenceRefs: strong.slice(0, 3).map((e) => e.index),
    },
    {
      statement: `${recent.length} of ${evidence.length} items were curated within the last 7 days, so the corpus is ${recent.length / evidence.length > 0.4 ? "current" : "materially stale"}.`,
      kind: "ASSESSMENT",
      confidence: 0.68 + rand() * 0.2,
      evidenceRefs: recent.slice(0, 3).map((e) => e.index),
    },
  ];

  // Persona claim — where specialization actually shows up in the output.
  pool.push(personaClaim(persona, ranked, approval, rand));

  // Each agent draws a seeded subset, so cohorts overlap without being clones.
  const drawn = pool.filter((_, i) => i < 3 || rand() > 0.28);

  // Some agents in a cohort take the contrary side, so the consensus engine has
  // a real disagreement to surface instead of unanimous agreement every run.
  //
  // The stance claim is *replaced*, never appended: an agent that asserted both
  // sides would be contradicting itself, which is a different defect entirely
  // and one the evaluation engine is supposed to punish.
  const stanceIndex = drawn.findIndex((c) => c.statement === stanceStatement("corroborated") || c.statement === stanceStatement("contested"));
  if (stanceIndex !== -1 && rand() > 0.62) {
    const majority = approval >= 0.75 ? "corroborated" : "contested";
    const minority = majority === "corroborated" ? "contested" : "corroborated";
    drawn[stanceIndex] = {
      statement: stanceStatement(minority),
      kind: "ASSESSMENT",
      confidence: 0.45 + rand() * 0.2,
      evidenceRefs: weak.length > 0 ? weak.slice(0, 2).map((e) => e.index) : ranked.slice(-2).map((e) => e.index),
    };
  }

  const confidence = clamp01(
    0.35 + meanQuality * 0.35 + Math.min(evidence.length / 20, 1) * 0.2 + rand() * 0.08,
  );

  const risks = [];
  if (weak.length > 0) {
    risks.push({
      description: `${weak.length} item(s) fall below a 0.45 quality floor and carry little curation backing.`,
      severity: weak.length / evidence.length > 0.4 ? "HIGH" : "MEDIUM",
      likelihood: clamp01(weak.length / evidence.length),
    });
  }
  if (recent.length / evidence.length < 0.25) {
    risks.push({
      description: "Most of the corpus predates the last curation week; conclusions may be stale.",
      severity: "MEDIUM",
      likelihood: 0.6,
    });
  }

  return {
    summary: `Across ${evidence.length} curated items (mean quality ${meanQuality.toFixed(2)}, ${(approval * 100).toFixed(1)}% curator approval), ${persona} finds the corpus ${approval >= 0.75 ? "well corroborated" : "contested"} on "${truncate(query, 100)}". The high-conviction subset of ${strong.length} item(s) is led by "${truncate(top.title, 70)}".`,
    claims: drawn,
    metrics: {
      evidenceCount: evidence.length,
      meanQuality: Number(meanQuality.toFixed(4)),
      approvalRate: Number(approval.toFixed(4)),
      highConvictionItems: strong.length,
      lowQualityItems: weak.length,
      recentItems: recent.length,
      totalVoteVolume: totalUp + totalDown,
    },
    recommendation: {
      action:
        approval >= 0.75 && meanQuality >= 0.6
          ? "Treat this corpus as decision-grade for the stated question."
          : "Gather corroborating evidence before acting on this corpus.",
      rationale: `Mean curation quality ${meanQuality.toFixed(2)} with ${(approval * 100).toFixed(1)}% approval across ${evidence.length} items.`,
      confidence: clamp01(confidence - 0.05),
    },
    risks,
    confidence,
  };
}

/** The two opposing positions an agent can take on corpus reliability. */
function stanceStatement(side: "corroborated" | "contested"): string {
  return side === "corroborated"
    ? "Curators broadly corroborate the corpus, indicating the underlying signal is reliable enough to act on."
    : "Curator disagreement is material, indicating the underlying signal should not be acted on without corroboration.";
}

function personaClaim(
  persona: string,
  ranked: EvidenceRow[],
  approval: number,
  rand: () => number,
): MockClaim {
  const p = persona.toLowerCase();
  const refs = ranked.slice(0, 2).map((e) => e.index);

  if (p.includes("security") || p.includes("risk")) {
    return {
      statement: `No item in the corpus has been flagged or banned by curators, so there is no active integrity signal against it.`,
      kind: "RISK",
      confidence: 0.66 + rand() * 0.18,
      evidenceRefs: refs,
    };
  }
  if (p.includes("onchain") || p.includes("defi") || p.includes("liquidity")) {
    return {
      statement: `Curation stake concentration favours the top-ranked item, so the corpus signal is driven by a narrow set of positions.`,
      kind: "ASSESSMENT",
      confidence: 0.63 + rand() * 0.2,
      evidenceRefs: refs,
    };
  }
  if (p.includes("research") || p.includes("document") || p.includes("dataset")) {
    return {
      statement: `Every retrieved item carries a resolvable upstream source, so the corpus is fully traceable to provenance.`,
      kind: "FACT",
      confidence: 0.8 + rand() * 0.12,
      evidenceRefs: refs,
    };
  }
  return {
    statement: `Curator approval will remain above 60% at the next epoch close for this corpus.`,
    kind: "PREDICTION",
    confidence: clamp01(approval * 0.85 + rand() * 0.1),
    evidenceRefs: refs,
    resolution: {
      metric: "corpus_approval_rate",
      operator: "gt",
      threshold: 0.6,
      source: "reppo:epoch-close",
      deadline: new Date(Date.now() + 1000 * 60 * 60 * 48).toISOString(),
    },
  };
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function withinDays(iso: string | null, days: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t <= days * 24 * 60 * 60 * 1000;
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32 — small, fast, reproducible PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
