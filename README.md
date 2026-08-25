# averis — the accountability layer between evidence and decisions

Turns curated data-network content into **verifiable, multi-agent
intelligence**.

Reppo coordinates and curates *data* through stake-backed prediction markets.
Averis sits above it and coordinates *intelligence*: several specialist
agents independently analyze the same curated corpus, their work is scored and
weighted, and the results are merged into structured claims that each trace
back to real provenance.

```
Reppo Datanets ─▶ Agent coordination ─▶ Evidence ─▶ Evaluation ─▶ Consensus ─▶ Intelligence API
```

Reppo is external infrastructure. Nothing here reimplements Datanets, pods,
voting or emissions.

## What makes it more than a fan-out

- **Evidence-first.** The tool runtime records provenance; the model only
  *cites* it. A reference to something never retrieved is dropped and the claim
  is flagged unsupported — a model cannot manufacture a source.
- **Disagreement is surfaced, never averaged.** Where agents genuinely
  conflict, both positions and both evidence trails are reported. An averaged
  claim no agent actually made destroys the trail on both sides.
- **Confidence ≠ consensus.** Reported separately, because a cohort can be
  confidently split.
- **Reputation is earned, not bought.** No stake input. Small samples shrink
  toward neutral, calibration is scored apart from accuracy, and old
  performance decays.
- **Budget is enforced before execution**, atomically — not discovered
  afterwards.

## Quick start

Requires Node ≥ 20.11 and Docker.

```bash
cp .env.example .env
npm install
npm run infra:up        # Postgres on :5433, Redis on :6379
npm run db:push
npm run db:seed         # 5 specialist agents
```

### The end-to-end demo

```bash
QUEUE_DRIVER=memory npm run demo
```

Runs the whole protocol in one process: reads **live Reppo Datanets**, selects
a capability-matched cohort, runs each agent independently, evaluates, merges,
and prints the final intelligence with its provenance. Needs Postgres but not
Redis, and **no LLM API keys** — the default `mock` provider derives its claims
from the real retrieved evidence.

Add `REPPO_PROVIDER=fixture` to run fully offline against recorded payloads.

### The full stack

```bash
npm run dev:all        # API + workers + web, all three at once
npm run dev:operator   # autonomous node (optional, separate)
```

Or start them individually:

```bash
npm run dev:api        # :4000  API gateway
npm run dev:workers    # job → evaluation → consensus → resolution
npm run dev            # :3000  web app
```

### What needs Docker, and what does not

Only the routes backed by the database need Postgres and Redis:

| Route | Needs Docker |
|---|---|
| `/` landing, `/whitepaper` | no |
| `/datanets` | no (reads Reppo's public API) |
| `/dashboard`, `/agents`, `/jobs/:id` | **yes** |
| `/playground` | depends on the endpoint being called |

## Layout

```
apps/
  web/         Next.js app — submit jobs, read intelligence reports
  api/         Fastify gateway — auth, rate limiting, validation
  operator/    Autonomous node — discovery, strategy, budget, execution
packages/
  types/           Domain contracts, job state machine, schemas
  protocol/        Job engine, lifecycle, execution pipeline, rewards
  agent-runtime/   LLM abstraction, tools, evidence collection
  consensus/       Claim clustering, weighting strategies, merge
  reputation/      Evaluation engine, reputation, agent selection
  strategy/        Operator job-selection policy
  budget/          Pre-execution spend guard and ledger
  reppo-adapter/   Reppo → provider-neutral normalization
  queue/           BullMQ / in-process driver abstraction
  db/              Shared Prisma client
  sdk/             Typed API client
workers/       Four lifecycle workers, one process
prisma/        Schema and seed
docs/          Architecture, protocol, agent, operator, Reppo integration
```

## Using the SDK

```ts
import { createClient } from "@averis/sdk";

const client = createClient({ baseUrl: "http://localhost:4000", apiKey: process.env.AVERIS_API_KEY });

const report = await client.runJob(
  {
    type: "dataset-evaluation",
    query: "Assess whether the curated geopolitical corpus is reliable enough to trade on.",
    requiredCapabilities: ["markets", "geopolitics"],
    requiredAgents: 3,
    budget: 3,
    minimumConfidence: 0.4,
  },
  { onStatus: (s) => console.log(s) },
);

console.log(report.intelligence.summary, report.intelligence.confidence);
for (const claim of report.intelligence.claims) {
  console.log(claim.statement, claim.supportingEvidence.map((e) => e.source));
}
```

`runJob` throws if the job ends `FAILED` rather than returning a partial
result — a caller who forgot to check `status` would otherwise act on
intelligence the protocol declined to stand behind.

The client covers jobs, datanets, agents and stats, carries no dependencies of
its own, and takes a `fetchImpl` — which is the seam for everything below.

### Paying from the SDK

When the gateway has the x402 paywall on, `createJob` raises
`PaymentRequiredError` carrying the decoded options: what is owed, in which
asset, on which network, to whom. The client does not pay by itself, because
paying needs a wallet and an API client should not quietly acquire one.

To pay, hand it a payment-capable `fetch`:

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { createClient } from "@averis/sdk";

const client = createClient({
  baseUrl: "http://localhost:4000",
  fetchImpl: wrapFetchWithPayment(fetch, x402Client),   // your signer
});
```

The 402 round trip then happens inside `fetch`, and every method on the client
stays unchanged.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Database, queue and provider status |
| GET | `/v1/datanets` | Browse upstream curated datasets |
| GET | `/v1/datanets/:id/data` | Items in one datanet |
| POST | `/v1/jobs` | Create an intelligence job (payable, see x402 below) |
| GET | `/v1/jobs` | List jobs |
| GET | `/v1/jobs/:id` | Job status and lifecycle audit trail |
| GET | `/v1/jobs/:id/intelligence` | Merged result, contributions, provenance |
| GET | `/v1/jobs/:id/explain` | Verdict, per-claim reasoning, upstream curation behind each source |
| GET | `/v1/agents` | Registry with reputation |
| POST | `/v1/agents` | Register an agent |

Auth is `Authorization: Bearer <key>`. An empty `API_KEYS` disables auth and
logs a loud warning — local development only.

### Playground

`/playground` calls these endpoints from the browser and shows the equivalent
curl and SDK code for whatever you just sent. Requests go through a server-side
proxy that attaches the API key, so the key never reaches the browser.

That proxy takes an **endpoint id**, not a URL. It builds the path itself from
a fixed catalogue (`apps/web/lib/playground.ts`), fills only the parameters
that endpoint declares, and encodes them — otherwise a page anyone can open
would be an open proxy holding the server's credentials. Writing endpoints are
labelled as such before you send: creating a job from here creates a real job
and spends real budget.

### Accounts and tenancy

Two kinds of key reach the gateway.

**Root keys** come from `API_KEYS` and see every tenant's work. The workers,
the operator and the demo run as root.

**Account keys** are minted per user and see only their own jobs:

```bash
npm run key:create -- --handle alice     # prints the key once
npm run key:create -- --list             # accounts, never keys
```

The raw key is shown once and stored only as a SHA-256 digest, so "lost it"
and "rotate it" are the same operation — run `key:create` again for the same
handle. Revocation takes effect within the resolution cache's 30s TTL.

A job created with an account key is stamped with its requester, and every
read of it — detail, intelligence, list, cursor, counts — carries the same
filter. Another account's job returns **404, not 403**: a reader who cannot
see a job should not be able to tell it apart from one that never existed.
Rate limits are keyed per key rather than per IP, so one noisy account cannot
exhaust anyone else's budget.

The web app still holds a single server-side `AVERIS_API_KEY` for all of its
traffic, so browser users share whatever identity that key carries. Per-user
sessions in the browser are the next step, not this one.

### Paying per job (x402)

`POST /v1/jobs` can be put behind an [x402](https://x402.org) paywall, so a
caller pays for a job instead of holding a key:

```bash
X402_ENABLED=true
X402_NETWORK=solana-devnet
X402_PAY_TO=<your address>
X402_FACILITATOR_URL=<a facilitator>
```

The request arrives without payment, the gateway answers `402` with what it
wants, and the client retries with a signed payload the facilitator verifies
and settles. `x402-fetch` or `@x402/axios` on the client side does that round
trip for you.

Four things are worth knowing about:

- **The fee is flat** (`X402_PRICE`, default 0.10 USDC), and separate from the
  job's `budget`, which remains the cap on what the protocol may spend on
  inference and tools. The two are not the same number because the price has to
  be quoted before Fastify parses the request body — the x402 hook runs at
  `onRequest` — so the declared budget is not available to price against.
- **Root keys skip the paywall.** The workers, the operator and the demo call
  this endpoint too. An account key is a customer and still pays.
- **The payment is recorded on the job it bought**, in `metadata.payment`.
- **Startup fails loudly** if the facilitator does not support the configured
  scheme and network, naming the pair it rejected. Check what one supports with
  `curl <facilitator>/supported` — coverage varies, and not every facilitator
  serves every Solana cluster.

A paid request with no key is anonymous: it has no account, so it gets no
tenancy — the job it creates is visible only to a root key. Present an account
key *and* pay to get both.

Only Solana is wired up, and the fee is charged once, up front. Both are noted
in the gaps below.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `…localhost:5433/averis` | 5433 avoids a locally installed Postgres |
| `QUEUE_DRIVER` | `bullmq` | `memory` runs everything in one process, no Redis |
| `REPPO_PROVIDER` | `http` | `fixture` for offline runs |
| `LLM_PROVIDER` | `mock` | `anthropic` \| `openai` \| `gemini` |
| `API_KEYS` | `dev-key-local` | Comma-separated *root* keys; empty disables auth |
| `AGENT_HTTP_ALLOWLIST` | *(unset)* | Enables `http_get` for the listed hosts only |
| `SETTLEMENT_DRIVER` | `none` | `ledger` records payments made off-chain; no on-chain driver exists |
| `X402_ENABLED` | `false` | Charges per job over x402; needs `X402_PAY_TO` |

See `.env.example` for the full set.

## Development

```bash
npm run typecheck        # whole monorepo
npm test                 # unit tests, no infrastructure needed
npm run test:integration # lifecycle tests against Postgres (needs infra:up)
npm run test:all         # both
npm run build            # web production build
npm run db:studio        # inspect the database
```

### Settling what is owed

The reward stage decides what is owed and writes it `PENDING`. Paying is a
separate, deliberate step:

```bash
npm run settle                    # print the plan — pays nothing
npm run settle -- --job <id>      # the plan for one job
npm run settle -- --execute       # actually pay
```

Printing is the default because settlement is the only irreversible operation
in this repository. The driver defaults to `none`, which refuses to pay rather
than pretending to: a no-op that reported success would mark rewards `SETTLED`
and destroy the record that they are still owed.

`SETTLEMENT_DRIVER=ledger` records a payment made outside this system, so the
same amount is not owed twice. There is no on-chain driver — writing a transfer
path nobody has ever run would put code that looks ready to move money next to
code that has moved none.

Three rules hold whatever driver is used. An agent with no payout address is
skipped rather than guessed at. A job whose rewards exceed its budget is held
in full, not paid down to the limit. And a reward is paid **at most once**:
claiming it is a conditional update, and the transaction row is unique per
reward, so two sweeps racing cannot both pay.

### Lifecycle tests

`tests/integration/` drives real jobs through the real pipeline against a real
Postgres, on a dedicated `averis_test` database that is created and truncated
automatically. The queue, the Reppo adapter and the LLM are pinned to
deterministic stand-ins so a failure means the protocol misbehaved, not that a
third party was slow.

`tenancy.test.ts` sits beside them and drives the gateway itself: key
resolution, rotation, and every read path that could hand one account another
account's job — including the list cursor and the summary counts.

The database is deliberately left real. Every concurrency bug found in this
codebase so far — the budget guard's check-then-commit window, the evidence
upsert race, queue redelivery — lived between two database calls and survived
the unit suite untouched. Reintroducing either of the first two makes these
tests fail immediately.

## Status

Implemented and exercised end to end: monorepo and infrastructure, job engine
and lifecycle, agent registry and runtime, Reppo integration, multi-agent
execution with evidence and consensus, deterministic evaluation, reputation,
the autonomous operator with strategy and budget, and a modular reward split.

Inbound payment over x402 is implemented and off by default; the outbound
half — paying agents on-chain — is not. `Reward` rows are written as `PENDING`
with their basis recorded, and nothing settles them.

Implemented but **not yet exercised**, which is a different claim:

- **Prediction resolution.** The stage, the `ResolutionOracle` interface and a
  working `CurationOracle` all exist, and the oracle returns a real reading
  from live Reppo data. But no prediction has actually matured yet, so
  `accuracy` and `calibration` still sit at the neutral prior for every agent.
  Until a deadline passes and the sweep runs, that half of reputation is
  untested in practice.
- **A real LLM cohort.** Every agent ships bound to the deterministic `mock`
  provider. The coordination mechanics are proven; whether *real* agents
  produce meaningfully different analyses, and whether merging them beats a
  single call, is the open question this project exists to answer.

Known gaps, in the order they are worth closing:

| Gap | Consequence |
|---|---|
| No Prisma migrations (`db push` only) | No safe deploy, no rollback |
| `DataItem` never written | A deleted upstream pod orphans an old job's evidence trail |
| Web traffic shares one server-side key | Browser users have no identity of their own yet |
| One oracle (`reppo:` sources only) | Price and on-chain predictions resolve as `UNRESOLVABLE` |
| No metrics or tracing | Cost, latency and failure rates are invisible |
| No on-chain settlement driver | Payments must be made elsewhere and recorded with the `ledger` driver |
| x402 charges a flat fee | A one-agent job costs the same as a five-agent one |
| x402 is Solana-only | An EVM payer cannot pay; the scheme exists, it is not registered |

Deliberately **not** built: protocol token, DAO, governance, custom chain,
custom inference network, ZK infrastructure, cross-chain.

## Deploying

Two Fly apps from one image: `fly.toml` runs the gateway and the workers as two
process groups, `fly.web.toml` runs the site. Two apps rather than one because
Fly gives an app a single hostname, and the gateway needs a public one of its
own for SDK callers.

```bash
fly launch --no-deploy --copy-config --config fly.toml
fly secrets set DATABASE_URL=… REDIS_URL=… API_KEYS=…
fly deploy --config fly.toml

fly launch --no-deploy --copy-config --config fly.web.toml
fly secrets set --config fly.web.toml AVERIS_API_KEY=…
fly deploy --config fly.web.toml
```

The site reaches the gateway over Fly's private network
(`AVERIS_API_URL=http://averis-api.internal:4000`), so that hop never leaves the
organisation. Both apps must be in the same org for that name to resolve.

Three things to get right, each of which fails quietly rather than loudly:

- **`REDIS_URL` must be a real TCP Redis.** BullMQ uses blocking commands; an
  HTTP/REST endpoint will not work.
- **`QUEUE_DRIVER=bullmq`.** The memory driver is only correct inside a single
  process — with it the API accepts jobs no worker will ever see.
- **Run `prisma migrate deploy` before the first release.** With no migrations
  directory it exits successfully having applied nothing, and the app then
  starts against an empty schema.

Vercel can host the site, but not the workers: they hold blocking queue
subscriptions and Vercel has no always-on process. Moving everything there
means replacing the queue driver with HTTP push — viable, because the lifecycle
is already idempotent under redelivery, but it is a rearchitecture rather than
a deploy target.

## Documentation

- **Whitepaper** — the protocol in one document, served by the web app at `/whitepaper`
- [Architecture](docs/architecture.md) — layers, replaceability, concurrency hazards
- [Protocol](docs/protocol.md) — lifecycle, evidence, evaluation, consensus, reputation
- [Agents](docs/agent.md) — runtime, LLM abstraction, tools, least privilege
- [Operator](docs/operator.md) — autonomy, strategy, budget guard, transaction safety
- [Reppo integration](docs/reppo-integration.md) — verified endpoints, curation → evidence weight
