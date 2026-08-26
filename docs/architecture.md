# Architecture

## What this is

An **accountability layer** that sits above curated data networks. It coordinates
agents; what it sells is that the result can be checked.
Reppo curates data through stake-backed prediction markets; Averis turns
that curated data into **verifiable intelligence** by coordinating independent
specialist agents, scoring their work, and merging it into a result whose every
claim traces back to provenance.

Reppo is treated as external infrastructure. Nothing here reimplements
Datanets, pods, voting or emissions.

```
Reppo Datanets ──▶ DataProvider ──▶ Job Engine ──▶ Agent cohort
                                                        │
                              ┌─────────────────────────┘
                              ▼
     Evidence ──▶ Structured output ──▶ Evaluation ──▶ Consensus
                                                        │
                              ┌─────────────────────────┘
                              ▼
             Reputation ◀── Prediction resolution     Intelligence API / SDK
```

## Layers

| Layer | Location | Responsibility |
|---|---|---|
| Client | `apps/web`, `packages/sdk` | Job submission, intelligence display, API playground |
| API gateway | `apps/api` | Auth, rate limiting, validation, read models |
| Protocol core | `packages/protocol` | Job engine, lifecycle, execution, reward split |
| Coordination | `packages/consensus`, `packages/reputation`, `packages/strategy` | Weighting, evaluation, scoring, selection |
| Agent infrastructure | `packages/agent-runtime` | LLM abstraction, tools, evidence collection |
| Data integration | `packages/reppo-adapter` | Reppo → provider-neutral normalization |
| Safety | `packages/budget` | Pre-execution spend enforcement |
| Data | `prisma/`, `packages/db`, `packages/queue` | Postgres, Redis/BullMQ |
| Autonomy | `apps/operator`, `workers/` | Unattended discovery and lifecycle execution |

## Identity and tenancy

The gateway resolves every request to a principal before a route sees it.

| Kind | Source | Sees |
|---|---|---|
| root | `API_KEYS` | every tenant's jobs |
| user | `users.apiKeyHash`, minted by `npm run key:create` | only its own jobs |
| none | auth disabled (`API_KEYS` empty) | everything, dev only |

Three properties are deliberate:

- **Keys are stored hashed.** Only a SHA-256 digest is persisted, so a database
  dump cannot be replayed against the gateway, and a lost key can only be
  rotated rather than recovered.
- **A malformed key never reaches the database.** Account keys have a fixed
  prefix and alphabet, checked before any lookup, so a flood of invented keys
  cannot turn into a query per request. Successful resolutions are cached for
  30s — which is also the revocation window.
- **Scoping is a filter, not a check after the fact.** `requesterScope()`
  becomes part of the `where` clause of each read, so another account's job is
  a 404 rather than a 403. A 403 would confirm the id exists, which is itself
  the leak. The same fragment is applied to the list cursor and to `/v1/stats`,
  because those are the two paths where a scoped read is easiest to forget.

The agent registry stays shared: agents are selected by capability, and scoping
the registry per tenant would quietly starve every cohort of its specialists.
Registration records `ownerId` without restricting who may select the agent.

`tests/integration/tenancy.test.ts` drives these paths through the real
gateway against the real database.

## Payments

`POST /v1/jobs` can sit behind an x402 paywall (`X402_ENABLED`, off by
default). The gateway answers an unpaid request with `402` and its payment
requirements; the client retries with a signed payload; a facilitator verifies
it and settles it on the configured EVM chain. The facilitator never holds
funds — it submits a transaction the payer already signed.

| Piece | Location |
|---|---|
| Price rules, network table, env parsing | `apps/api/src/payments/config.ts` |
| SDK wiring, paywall registration | `apps/api/src/payments/index.ts` |

Four decisions carry the design:

- **The fee is flat, and that is a constraint rather than a preference.** The
  x402 hook runs at Fastify's `onRequest`, before the body is parsed, so the
  job's declared budget cannot be priced against. Quoting a budget passed in
  the query string would be possible but not enforceable: settlement happens
  before the handler ever sees the body, so a caller who quoted low and
  declared high would have to be refunded rather than refused. A flat fee is
  the version of this that cannot be gamed.
- **The facilitator is synced at startup, not per request.** The resource
  server refuses to build a challenge for a scheme it has not confirmed is
  supported, so the sync is mandatory; doing it in `registerPayments` turns an
  unsupported pair into a startup failure that names the pair, and keeps every
  request to this route — including the root-key ones that skip the paywall —
  from waiting on that call.
- **The SDK is imported dynamically.** An installation with payments off never
  loads `@x402/*` and never pays for its dependency tree at startup.
- **Root keys are waived, account keys are not.** The workers, the operator and
  the demo call this endpoint; customers pay for it. The waiver is a
  constant-time comparison against `API_KEYS`, resolved through the same header
  extraction the auth hook uses, so the paywall and the auth hook can never
  disagree about what counts as a key.
- **Config failures are startup failures.** Payments on with no recipient or no
  facilitator throws in `buildServer`. A paywall that quietly lets everything
  through is worse than one that refuses to start.

Auth and the paywall compose rather than conflict: on a paid route a keyless
request is allowed past the auth hook with a null principal so it can reach the
paywall, which then demands payment. Such a request has no account, so it also
has no tenancy — the job it creates is visible only to a root key.

The outbound direction is not built. `Reward` rows are written `PENDING` with
their basis recorded and nothing settles them; `SETTLEMENT_DRIVER` is read by
nothing today.

## Web surface

Two route groups under `apps/web/app`, so the landing page renders as a bare
full-viewport frame while the product routes keep their header and footer:

| Route | Group | Needs the database |
|---|---|---|
| `/` | `(landing)` | no |
| `/dashboard` | `(app)` | yes |
| `/datanets` | `(app)` | no, reads Reppo directly |
| `/agents`, `/jobs/:id` | `(app)` | yes |
| `/playground` | `(app)` | whatever the called endpoint needs |
| `/whitepaper` | `(landing)` | no |

The landing page is one client shell — `landing-shell.tsx`, which owns the
menu, the escape handling and the hero's entrance motion — wrapping a stack of
server-rendered sections in `components/landing/`: the example report, how it
works, domains, principles, the comparison matrix, the developer surface, the
FAQ and the footer. Only the shell and the code-sample tabs ship JavaScript, so
`/` still prerenders as static content and reaches no database. Sections below
the fold are revealed on scroll by `reveal.tsx`, which rests *visible* in CSS
and arms itself only when motion is welcome and the block starts below the
fold — a reader with JavaScript off, or reduced motion set, gets the finished
state directly.

`/playground` is a credentialed forwarder, and is built as a closed list for
that reason. The browser posts an endpoint id from the catalogue in
`apps/web/lib/playground.ts`; `app/api/playground` looks it up, builds the path
from the template, encodes each declared parameter, drops undeclared query keys
and attaches the key server-side. There is no path field to pass through, so
the credential can only ever reach URLs the catalogue describes. The gateway
address is read from `AVERIS_API_URL` at runtime rather than a `NEXT_PUBLIC_*`
value, which would be inlined at build time and pin a deployed proxy to
whatever gateway the build machine was pointed at.

## Deviations from the original specification

Three packages were added, each for a stated reason:

**`packages/protocol`** — the specification's architecture diagram names a
"PROTOCOL CORE" layer but the package list has no home for it. Job lifecycle
and orchestration are used by the API, all four workers and the operator; the
alternative was a cross-app import from `apps/api`, which would have made the
API a dependency of every worker.

**`packages/db`** — one shared Prisma client. Without it, seven processes each
construct their own client and pool.

**`packages/queue`** — a `QueueDriver` interface with BullMQ and in-process
implementations. The engineering principles require every subsystem to be
replaceable, and this specific one buys something concrete: the whole pipeline
runs and is tested without Redis.

One structural change: `workers/` is a single workspace with four entrypoints
(`job-worker/`, `evaluation-worker/`, `consensus-worker/`, `resolution-worker/`)
rather than four packages. Same layout, without 4× the package overhead. They
already have separate queues and separate modules, so splitting them into
separate deployments later is a change to `workers/src/main.ts` alone.

## Replaceability

Every subsystem is reached through an interface, and only the composition root
(`packages/protocol/src/context.ts`) constructs implementations.

| Interface | Implementations | Swap by |
|---|---|---|
| `DataProvider` | `ReppoHttpProvider`, `ReppoFixtureProvider` | `REPPO_PROVIDER` |
| `LLMProvider` | Anthropic, OpenAI, Gemini, Mock | Per-agent registry row |
| `QueueDriver` | `BullMQDriver`, `MemoryQueueDriver` | `QUEUE_DRIVER` |
| `WeightingStrategy` | `MultiFactorWeighting`, `UniformWeighting` | `ConsensusEngine` config |
| `ClaimClusterer` | `LexicalClusterer` | `ConsensusEngine` config |
| `SpendLedger` | `PrismaSpendLedger`, `MemorySpendLedger` | `BudgetGuard` construction |
| `ResolutionOracle` | `CurationOracle` | `ResolutionStage` construction |
| `AgentTool` | Reppo tools, compute, HTTP | `ToolRegistry` |

The LLM provider is per-agent rather than global on purpose: a cohort drawn
from a single vendor has correlated errors, which is precisely the failure
multi-agent consensus exists to catch.

## Data flow for one job

1. **Discovery** — the job's required capabilities are matched against datanet
   domains; the top datanets by curator approval become the job's scope. Every
   agent in the cohort then reads the *same* pool, so "agents disagreed" cannot
   be confused with "agents read different data".
2. **Selection** — `AgentSelector` scores candidates on capability match,
   domain reputation, availability and marginal diversity.
3. **Execution** — agents run in parallel, each under its own budget
   reservation, each writing evidence through the tool runtime.
4. **Evaluation** — `EvaluationEngine` scores each output deterministically.
5. **Consensus** — `ConsensusEngine` clusters claims, weights agents and merges.
6. **Reward** — the budget is split by earned weight and recorded as pending.
7. **Resolution** — prediction claims are scored against oracles after their
   deadline, feeding accuracy and calibration back into reputation.

## Concurrency hazards handled

Three races were found and fixed during implementation; they are the reason
several code paths look more careful than they otherwise would.

- **Budget check/commit** — `check` then `reserve` is not atomic. Ten
  concurrent callers all read the same headroom and all spend it. `reserve`
  now holds a lock (in-process `KeyedMutex`, or a Postgres advisory lock via
  `SpendLedger.withLock` across processes).
- **Evidence insertion** — parallel agents retrieve the same pods. Two
  transactions both see "not present" and both insert; one dies on the unique
  constraint and loses its entire output. Now `createMany({ skipDuplicates })`,
  which compiles to `ON CONFLICT DO NOTHING`.
- **Queue redelivery** — at-least-once delivery is normal. Every transition
  validates against the job's *persisted* status inside a transaction, and
  terminal states refuse further transitions.

See `docs/protocol.md` for the lifecycle and `docs/operator.md` for the
autonomy and safety model.
