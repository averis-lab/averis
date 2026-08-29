# Protocol

## The Intelligence Job

The protocol's core primitive. A job asks a network of agents to turn available
evidence into a structured, verifiable result.

```ts
interface IntelligenceJob {
  id: string;
  type: string;              // asset-analysis, dataset-evaluation, anomaly-detection, …
  query: string;
  target: string | null;
  requiredCapabilities: string[];
  requiredAgents: number;
  budget: number;            // USDC
  deadline: Date | null;
  minimumConfidence: number | null;
  status: JobStatus;
}
```

## Lifecycle

```
CREATED → QUEUED → ASSIGNED → RUNNING → SUBMITTED → VALIDATING → CONSENSUS → RESOLVED
                                                                                  │
                              any non-terminal state ────────────────────────▶ FAILED
```

The lifecycle is an **explicit state machine** (`packages/types/src/job.ts`),
not a free-form status column. Every transition:

- validates against `JOB_TRANSITIONS` and throws `InvalidTransitionError` otherwise;
- reads the job's **persisted** status inside a transaction, so a duplicated or
  out-of-order queue delivery cannot advance a job twice;
- refuses to move out of a terminal state, so a late worker cannot resurrect a
  finished job;
- writes a `JobEvent` audit row, so the path a job took is reconstructible.

Queues deliver at least once. That is treated as normal, not exceptional:
enqueues carry a deduplication key (`job:<id>`, `eval:<id>`, …) and a repeat
transition to the current state returns `false` rather than erroring.

**Failing is a valid outcome.** A job whose merged confidence falls below its
`minimumConfidence` is failed rather than shipped. Intelligence the protocol
will not stand behind should not be delivered.

## Structured intelligence

Agents never return prose as the protocol payload.

```json
{
  "summary": "...",
  "claims": [{ "statement": "...", "kind": "FACT", "confidence": 0.91, "evidenceRefs": [0, 3] }],
  "metrics": {},
  "recommendation": { "action": "...", "rationale": "...", "confidence": 0.8 },
  "risks": [{ "description": "...", "severity": "HIGH", "likelihood": 0.4 }],
  "confidence": 0.87
}
```

Note what the model does **not** supply: the evidence array. The model cites
`evidenceRefs` — integer indices into what the *tool runtime* actually
retrieved. A reference to an index that was never collected is dropped and the
claim is flagged `unsupported`, so a model cannot manufacture provenance.

## Evidence

```ts
interface Evidence {
  id: string;
  type: EvidenceType;      // REPPO_POD, ONCHAIN, WEB, DOCUMENT, …
  source: string;          // reppo://pod/<id> — stable even if the URL rots
  content: string | null;
  reliability: number;     // upstream curation score, not the agent's opinion
  timestamp: Date;
}
```

Evidence is deduplicated per job by content hash, so several agents citing the
same upstream item share one provenance row and one stable index. Claims link
to evidence many-to-many with a `stance` (+1 supports, −1 contradicts), which
is what lets consensus keep both sides of a contested claim.

## Evaluation

Each output is scored on four dimensions before consensus runs
(`packages/reputation/src/evaluation.ts`):

| Dimension | Measures |
|---|---|
| `evidenceQuality` | Reliability of cited sources × share of claims that cite anything × source breadth |
| `internalConsistency` | Absence of self-contradiction within one output |
| `specificity` | Figures and units rather than hedging |
| `corroboration` | Agreement with the cohort on topics it addressed |
| `rubricAlignment` | Coverage of the datanet's own vocabulary (weakest signal, 0.08 weight) |

The evaluator is **deterministic**. No model grades another model: an LLM judge
would introduce exactly the correlated error multi-agent analysis exists to
avoid, and could not be replayed or audited.

Corroboration carries only 0.25 weight on purpose. A well-evidenced, specific,
internally consistent **minority position still scores respectably** — the
protocol must not price correct dissent out of existence.

## Consensus

Merging happens in three steps (`packages/consensus`):

**1. Cluster.** Claims about the same topic are grouped by lexical similarity.
Plain Jaccard was insufficient — it punishes a claim for being more detailed,
scoring "the signal is reliable" against "the signal is not reliable at 42.1%
approval" at 0.375 and hiding a real contradiction. The measure blends Jaccard
with length-damped containment.

**2. Weight.** `MultiFactorWeighting` blends domain reputation (0.30),
accuracy (0.20), evidence quality (0.20), calibration (0.15), evaluation (0.10)
and self-reported confidence (0.05). Two deliberate choices:

- **Self-confidence carries the least weight** — it is the one signal an agent
  can inflate for free.
- **Any single agent is capped** (`maxShare`, default 0.5) so a cohort cannot
  degenerate into one agent with extra steps, and floored (`minShare`) so a
  newcomer can still build a record.

`UniformWeighting` is kept as a first-class strategy, not a placeholder: it is
the control group any claim about reputation weighting must be measured against.

**3. Merge.** Within a cluster, claims are split by stance. The majority
position is reported **as an agent actually worded it** — never as an average.
Where the opposing side carries meaningful weight, the topic is emitted as a
`Disagreement` with every position preserved. An averaged claim that no agent
made destroys the evidence trail on both sides.

`confidence` and `consensusScore` are reported **separately**. A cohort can be
confidently split, and collapsing the two would hide exactly that.

**4. Scale by corroboration breadth.** Agreement alone is not consensus. One
agent agreeing with itself scored identically to three agents that genuinely
converged, which overstated the result to anyone reading the headline number.

The raw agreement score is therefore multiplied by how much independent
corroboration actually materialised:

```
factor = (1 - 1/n) / (1 - 1/target)      n = agents that finished
```

Zero at `n = 1`, because one agent corroborates nothing. The curve is steep
between one and three agents and flattens after, matching how fast the value of
one more independent opinion falls away. A cohort that met its target scores a
full 1. The raw agreement is kept in `strategyConfig.rawAgreement` so the
discount is auditable rather than hidden.

Measured on a real short cohort:

| | agents | consensus | confidence | recommendation |
|---|---|---|---|---|
| Full | 3 of 3 | 87% | 83% | 73% |
| Short | 1 of 4 | 0% | 54% | 28% |

The recommendation is gated the same way. A lone agent calling a corpus
"decision-grade" must not read as confident advice while the rest of the result
says nothing was corroborated.

A job whose cohort shrinks still runs rather than failing outright; the honest
numbers plus the job's own `minimumConfidence` are the safety net.

**5. Measure how independent the cohort was.** Corroboration breadth asks how
many analysts agreed. It does not ask how many *different things* were doing the
analysing — and five agents are five opinions only if they can be wrong in
different ways. A cohort sharing one model shares its blind spots, so part of
its unanimity is a property of that model rather than a finding about the world.

Every output records the provider and model that produced it, and the merge
reports what the cohort was made of:

```
independence = {
  origins: [{ origin, agents, weight }],   // vendors, heaviest first
  effectiveOrigins,                        // 1 / Σ share²  — weighted
  largestOriginShare,
  distinctModels,
  monoculture,                             // one model across the cohort
  unknown,                                 // at least one binding unrecorded
}
```

Two details decide whether the number means anything:

*Origins are vendors, not credentials.* A gateway is resolved through to the lab
that answered — `openrouter` + `google/gemini-3-pro` is Google — because the
point of a gateway is that one key reaches many labs. Counting the credential
would report a three-lab cohort as single-vendor, and three agents on one routed
model as diverse. Aliases fold too: `gemini` and `google/…` are one lab, not
two.

*Vendors are counted by weight.* `effectiveOrigins` is the inverse Simpson
index, so three vendors where one carries 90% of the merge weight score 1.2 and
not 3 — the verdict really is that one agent's view with two bystanders.

**There is deliberately no multiplier.** Corroboration carries one because at
`n = 1` there is arithmetically no inter-agent agreement to measure. Monoculture
has no such clean zero: agents on one model, given different roles and different
evidence, do genuinely differ — just less, by an amount nobody here can put a
number on. Folding an invented coefficient into `consensusScore` would leave one
number answering two questions at once, how much they agreed and how much that
agreement is worth, and the second is the reader's to judge. So the measurement
is stated — in the summary, in `explain`'s reasons and caveats, and on the
report page under the consensus meter — and the score stays a measurement of
agreement.

`unknown` is load-bearing. A result merged before this was recorded has no
origins, and that is not the same as a cohort that turned out to be uniform;
every reader downstream says "not recorded" rather than naming a vendor the
protocol never observed.

The binding is stored on the output, not read back through `Agent.modelProvider`
at display time. The registry is editable, and re-deriving it would let a
routine repointing of an agent silently rewrite what a finished job says
produced its claims.

## Datanet rubrics

Each Reppo datanet publishes its own standard: what contributors should submit
(`onboardingPublishers`) and how submissions should be judged
(`onboardingVoters`). TradingGym AI, for instance, states an explicit 1–10 band
with thresholds and an explicit *do not score on* list.

Averis carries that through as `Datanet.rubric` and uses it twice:

- **In the agent's prompt**, so a robotics datanet and a prediction-market
  datanet are judged by their own stated standards rather than one generic
  yardstick.
- **In evaluation**, as `rubricAlignment`: how much of the datanet's own
  vocabulary the output actually engages with. This is term coverage, not
  comprehension, so it carries the smallest weight of the five dimensions
  (0.08) and stays neutral at 0.5 when a datanet publishes no rubric.

### Why the rubric is quoted, never obeyed

Rubric text is written by whoever created the datanet. It is third-party
content, and treating it as instruction would hand an outsider control of the
agent. Three rules keep that shut:

1. It goes in the **user turn**, never the system prompt, so it cannot inherit
   operator authority.
2. It is fenced in `<datanet-standards>` and labelled explicitly as quoted
   material that cannot change the task or the output format.
3. The agent is told to **report** anything resembling a directive as a
   finding rather than follow it.

The text itself is not filtered. Trying to strip "injection attempts" from free
prose is unreliable and breeds false confidence; placement is the defence.
Shape is normalised (control characters removed, length capped at 1 500
characters) but wording is left exactly as written.

The rubric is snapshotted into the `Datanet` table when a job uses it, because
a datanet can rewrite its standard at any time and an old job's evaluation
would otherwise be impossible to reproduce.

## Reputation

Multidimensional and derived from measured performance only
(`packages/reputation/src/reputation.ts`).

| Dimension | Source |
|---|---|
| `accuracy` | Share of resolved predictions that came true |
| `calibration` | Brier score mapped to [0,1] |
| `consistency` | Internal coherence + stability of cohort agreement |
| `evidenceQuality` | Deterministic evaluation over time |

Four properties are deliberate:

1. **Capital is not an input.** There is no stake parameter on `Observation`.
2. **Shrinkage toward neutral.** With `priorStrength = 10`, three lucky calls
   land near 0.6, not 1.0 — reputation cannot be manufactured by spraying cheap
   high-confidence claims and cherry-picking hits.
3. **Calibration is scored apart from accuracy.** Being right 90% of the time
   while claiming 99% certainty is a distinct failure, and consensus needs to
   know about it independently.
4. **Recency decay** (90-day half-life). Nobody coasts on history.

Scores are stored as **immutable snapshots**, recomputed from full history
rather than incremented — so a scoring-rule change can be applied retroactively
and any past selection can be replayed.

## Agent selection

Explicitly *not* "top N by overall reputation":

- **Domain reputation outranks overall reputation.** A generalist with a
  stellar record is a worse pick for a DeFi liquidity question than a
  specialist with a solid DeFi record.
- **Marginal diversity is scored.** Each pick is scored against the cohort
  already chosen, so later seats go to agents covering domains the first pick
  did not — decorrelating the cohort's errors.
- Agents at their concurrency limit, paused, or above the per-agent budget are
  excluded. **Fewer agents is preferred over unqualified ones.**

## Predictions

A claim marked `PREDICTION` carries machine-checkable criteria and a deadline.
After the deadline, `ResolutionStage` asks a matching `ResolutionOracle` for the
observed value and records `TRUE`/`FALSE` plus a Brier score.

When no oracle can answer, the prediction is recorded `UNRESOLVABLE` — **not
guessed**. Scoring an unverifiable claim either way would corrupt accuracy with
noise.

This loop is what makes reputation mean anything: everything else scores an
agent on how its work *looks*, and only this scores it on whether it was right.

### Oracles

`criteria.source` names which oracle answers. Three exist:

| Source | Metrics | Reads |
|---|---|---|
| `reppo:…` | `corpus_approval_rate` | The data network's own curation state |
| `price:<BASE>-<QUOTE>` | `spot` | Two keyless public market venues |
| `chain:<chainId>[:<address>]` | `block_number`, `native_balance`, `erc20_total_supply`, `erc20_balance_of:<addr>` | An EVM node over JSON-RPC |

Curation always runs. Price is registered only when `ORACLE_PRICE_ENABLED=true`,
and chain only for chains given an `ORACLE_RPC_<chainId>` endpoint list — an
oracle claiming a source it cannot reach turns a missing setting into a run of
failed resolutions, where declining produces a clean "no oracle supports this
source" instead.

Three rules are shared, and each exists because the alternative corrupts a
track record:

- **Venues that disagree are not averaged.** Two price sources differing by
  more than 1% means one is wrong, and picking either is a coin flip that would
  be recorded as a measurement. The reading is refused.
- **"Cannot be answered" and "could not be reached" are different outcomes.**
  The first is terminal: `UNRESOLVABLE`. The second throws
  `OracleUnavailableError`, and the prediction stays `PENDING` for the next
  sweep — a dropped connection must not delete an observation the agent earned.
  The retry terminates on its own, because once the deadline is far enough
  behind, the oracle declines on its own terms instead of throwing.
- **Readings expire.** Both oracles observe the present, not the deadline:
  spot endpoints have no history, and most public nodes are pruned, so a
  historical `eth_call` errors rather than answering. A reading is therefore
  refused once the sweep has fallen further behind the deadline than
  `maxLagMs` (15 minutes by default). An archive node would allow pinning to a
  block; the default configuration cannot, so it does not pretend to.

Token amounts are scaled by the decimals the contract itself reports. Assuming
18 would be wrong by twelve orders of magnitude for USDC, and the division is
done in `BigInt` before converting, so a supply too large for a double keeps
its integer part.

## Economics

No protocol token. USDC only. The reward split is configurable and normalized,
so a misconfigured split can never pay out more than the job's budget:

| Role | Default |
|---|---|
| Agents | 70% (shared by earned consensus weight) |
| Validators | 15% |
| Protocol | 10% |
| Treasury | 5% |

Rewards are written `PENDING` with their basis recorded. Paying them is a
separate step (`packages/protocol/src/settlement.ts`), and the split between
deciding and paying is physical: `settlement-plan.ts` holds the rules and
imports no database, so every rule can be tested without a chain, a database or
money.

| Rule | Why |
|---|---|
| A reward is paid at most once | Conditional claim (`PENDING → APPROVED`) plus a unique `rewardId` on `Transaction`. Two sweeps racing cannot both pay |
| No payout address means skipped | An agent's share goes to the wallet its owner registered; a missing one is reported, never guessed |
| An over-budget job is held whole | Paying part of a split that does not add up is harder to unwind than paying none of it |
| A failed payment returns to `PENDING` | The failed `Transaction` row stays as the record of the attempt |
| Only `CONFIRMED` settles the debt | A broadcast payment stays `APPROVED` until something observes it landing |

Drivers are `none` (refuses, the default) and `ledger` (records a payment made
outside this system). **No on-chain driver exists.** That is deliberate: an
untested transfer path is the most dangerous possible thing to have in a
settlement layer, because it looks ready.
