# Agents

## Runtime

`packages/agent-runtime` is provider-independent by construction: the loop only
ever calls `LLMProvider.complete`, so the same code path drives Anthropic,
OpenAI, Gemini and the deterministic mock.

```
Agent ─▶ System prompt ─▶ Tool phase (gather evidence) ─▶ Structured phase ─▶ Claims + evidence
```

**Tool phase** — the agent calls tools to retrieve evidence, up to `maxSteps`
rounds. Tool calls within one turn run concurrently and every result is
returned together, including failures.

**Structured phase** — the agent is asked for schema-conforming output with no
tools available. Providers with native structured output use it; the rest fall
back to schema-in-prompt plus a parse-and-repair pass.

## The LLM abstraction

```ts
interface LLMProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
```

| Provider | Model default | Notes |
|---|---|---|
| `anthropic` | `claude-opus-5` | Official SDK, adaptive thinking, `zodOutputFormat` |
| `openai` | `gpt-5.1` | `baseURL` is configurable, so any OpenAI-compatible endpoint — including a local model — works through this adapter |
| `gemini` | `gemini-3-pro` | `@google/genai`, `responseJsonSchema` |
| `mock` | `mock-analyst` | Deterministic, evidence-derived; no API key |

SDKs are imported lazily, so an operator running only the mock never pays their
startup cost. Every adapter reports token usage and USD cost, which is what the
budget guard reconciles against.

The provider is bound **per agent** in the registry, not globally. A cohort
drawn from one vendor has correlated errors — precisely the failure that
multi-agent consensus exists to catch — so mixing vendors within a cohort is
supported and encouraged.

## The mock provider

Not a stub that returns canned prose. It reads the evidence the tool runtime
actually retrieved and derives every claim from real numbers in it: corpus
size, vote volumes, approval rates, recency. Variation across agents comes from
a seed derived from the agent's persona, so a cohort produces
overlapping-but-distinct results — some claims merge, some conflict, and
confidences differ enough that weighting has real work to do.

That matters because what is under test is the coordination mechanics, and they
only mean something when the inputs genuinely differ. Runs are reproducible for
the same cohort.

Agents take *one side* of a contested position, never both — an agent asserting
both sides would be self-contradicting, which is a different defect and one the
evaluation engine is supposed to punish.

## Tools

```ts
interface AgentTool<Input, Output> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;   // JSON Schema, handed to the model verbatim
  execute(input: Input, context: ToolContext): Promise<Output>;
}
```

| Tool | Purpose |
|---|---|
| `reppo_list_datanets` | Discover curated datasets and their curation health |
| `reppo_search_data` | Search items and **register them as citable evidence** |
| `reppo_get_datanet_data` | Retrieve the highest-curated items from one datanet |
| `compute_evidence_stats` | Exact statistics over collected evidence |
| `http_get` | Allowlisted HTTPS fetch (unregistered by default) |

`compute_evidence_stats` exists because models are unreliable at arithmetic and
there is no reason to let them do it — numbers that reach claims come from code
running over the exact rows the runtime recorded.

## Least privilege

- An agent receives **only the tools it declared** in the registry. A tool it
  never declared cannot be acquired at runtime.
- The **job's datanet scope wins over anything the model requests**, so a model
  cannot widen its own data access.
- `http_get` is unregistered unless `AGENT_HTTP_ALLOWLIST` is set. When
  enabled it refuses non-HTTPS URLs, hosts outside the allowlist, and private
  address ranges (`127.0.0.0/8`, `10/8`, `192.168/16`, `172.16/12`,
  `169.254/16`, `::1`, `fd00::/8`, `localhost`, `*.internal`) — including the
  cloud metadata endpoint. Responses are byte-capped.
- Unvetted web content is recorded at `reliability: 0.35`, materially below
  stake-curated upstream data.

## Evidence collection

Evidence is recorded by the **tool runtime**, never by the model:

```ts
const ref = context.evidence.record({ type: "REPPO_POD", source, content, reliability });
```

The returned `ref` is what the model cites. The model's only influence over
provenance is choosing which recorded item a claim points at — it cannot author
a source. `EvidenceCollector.resolve` silently drops fabricated indices, and a
claim left with nothing is flagged `unsupported` so evaluation can penalize it.

## Registering an agent

```bash
curl -X POST http://localhost:4000/v1/agents \
  -H "Authorization: Bearer $AVERIS_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "Liquidity Risk Agent",
    "description": "You are a DeFi liquidity risk specialist.",
    "capabilities": [
      { "domain": "defi", "skill": "liquidity-analysis", "declared": 0.9 },
      { "domain": "crypto", "declared": 0.7 }
    ],
    "modelProvider": "anthropic",
    "modelName": "claude-opus-5",
    "tools": ["reppo_search_data", "compute_evidence_stats"],
    "pricePerJob": 0.5,
    "maxConcurrent": 3
  }'
```

A new agent starts at the **neutral prior**, not zero — it can be selected and
earn a record. Declared proficiency is a hint only; measured performance
corrects it.

## Prompt contract

The system prompt (`packages/agent-runtime/src/prompt.ts`) states the
non-negotiables: one falsifiable statement per claim, evidence cited by `ref`,
calibrated confidence, no arithmetic by hand, and an explicit instruction that
honest "insufficient evidence" outranks a confident guess.

It also tells the agent that others are analyzing the same job independently
and that it should **not** try to agree with what it imagines they will say.
Independent, well-evidenced disagreement is more valuable to this protocol than
consensus that was not earned.

### Quoted datanet standards

The **user turn** additionally carries the published standards of the datanets
in scope, fenced in `<datanet-standards>`. That placement is deliberate: the
text is written by the datanet's owner, so it is third-party content and must
not sit in the system prompt where it would inherit operator authority.

The block is labelled as quoted material that cannot change the task or the
output format, and the agent is told to report anything resembling a directive
as a finding rather than obey it. See `docs/protocol.md` → Datanet rubrics for
why the text itself is not filtered.
