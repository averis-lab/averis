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
npm run db:deploy       # applies prisma/migrations
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
| `/dashboard`, `/agents`, `/jobs/:id`, `/automation` | **yes** |
| `/playground` | depends on the endpoint being called |

## Layout

```
apps/
  web/         Next.js app — submit jobs, read intelligence reports, run automations
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
  execution/       Trade policy, pure entry/exit planning, execution drivers
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
| GET | `/v1/automations` | Deployed automations, with derived breaker state |
| POST | `/v1/automations` | Deploy one — stopped, in paper mode |
| POST | `/v1/automations/:id/evaluate` | Run one resolved job past its policy |
| GET | `/v1/automations/:id/positions` | Positions, each linked to the job that opened it |

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
X402_NETWORK=robinhood          # a label for logs; the chain id is what binds
X402_CHAIN_ID=<evm chain id>
X402_RPC_URL=<rpc endpoint>
X402_ASSET=<usdc contract, 0x…>
X402_PAY_TO=<your address, 0x…>
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
- **Nothing is hardcoded.** There is no table of known networks: the chain id,
  the RPC endpoint and the USDC contract all come from the environment and the
  paywall refuses to start without them. A wrong token address is not a
  misconfiguration, it is funds sent somewhere nobody controls, so the same rule
  that forbids a default `X402_PAY_TO` covers all three. Both addresses are
  checked against `0x` + 40 hex at startup, which catches an address from
  another chain pasted into an EVM field.
- **Startup fails loudly** if the facilitator does not support the configured
  scheme and network, naming the pair it rejected. Check what one supports with
  `curl <facilitator>/supported` — coverage varies, and not every facilitator
  serves every EVM chain.

A paid request with no key is anonymous: it has no account, so it gets no
tenancy — the job it creates is visible only to a root key. Present an account
key *and* pay to get both.

The fee is charged once, up front, and no payment has ever settled end to end
against a live facilitator. The challenge is issued and now names a scheme that
matches the chain — the paywall previously registered a scheme from another
chain family against an `eip155:` network, a pair no facilitator can verify. Both are noted in the
gaps below.

### Automation (trading)

`/automation` deploys an agent that turns resolved intelligence jobs into
positions. It is a **consumer** of the protocol, not part of it: nothing in
`packages/protocol` knows the `automations` table exists.

```bash
EXECUTION_DRIVER=paper
EXECUTION_PRICE_URL='https://<a quote endpoint you verified>?ids={token}'
PRIVY_APP_ID=…        # optional: own automations by wallet
PRIVY_APP_SECRET=…
```

With Privy set, an automation belongs to the **wallet that deployed it**. The
browser presents a Privy identity token and the *gateway* verifies its
signature — a wallet address sent as a parameter is a claim anyone can make, and
an endpoint that trusts one has authentication in name only. Connecting grants
**identity, not custody**: Averis asks for no key, holds none, and cannot sign.

A position opens only when the cohort's verdict clears every gate the owner
configured — confidence and consensus as **separate** floors, a minimum number
of agents that actually finished, and zero claims citing evidence the runtime
never retrieved. Every position links back to the job that opened it, so "why
this one" is answerable in claims and evidence rather than in a signal.

Four things are worth knowing about:

- **There is no live driver, and `LIVE` returns 501.** The default refuses, as
  `SETTLEMENT_DRIVER` does — but unlike settlement, nothing here has been
  written to trade: an untested swap path beside code that has never executed
  a trade is dangerous precisely because it looks ready.
- **There is no custody.** No key column, no wallet the server signs with. An
  automation holds a name, a policy and two switches.
- **Both defaults refuse.** With no driver nothing opens; with no price source
  nothing marks. A position is never marked to a guess.
- **Start and mode are separate switches.** One says the automation may trade,
  the other says whether those trades cost anything. Stopping blocks new entries
  only — open positions keep being exited by their own rules.

Nothing polls yet: `evaluate` and `sweep` are called from the dashboard or by a
caller you write. See [docs/automation.md](docs/automation.md).

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `…localhost:5433/averis` | 5433 avoids a locally installed Postgres |
| `QUEUE_DRIVER` | `bullmq` | `memory` runs everything in one process, no Redis |
| `REPPO_PROVIDER` | `http` | `fixture` for offline runs |
| `LLM_PROVIDER` | `mock` | `anthropic` \| `openai` \| `gemini` |
| `API_KEYS` | `dev-key-local` | Comma-separated *root* keys; empty disables auth |
| `AGENT_HTTP_ALLOWLIST` | *(unset)* | Enables `http_get` for the listed hosts only |
| `SETTLEMENT_DRIVER` | `none` | `ledger` records payments made off-chain; `evm` transfers an ERC-20 on chain |
| `X402_ENABLED` | `false` | Charges per job over x402; needs `X402_PAY_TO` |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` | *(unset)* | Wallet login; both or neither, half-configured throws at startup |
| `EXECUTION_DRIVER` | `none` | `paper` books simulated fills; there is no live driver |
| `EXECUTION_PRICE_URL` | *(unset)* | Quote endpoint for exit sweeps; without one nothing opens or marks |

See `.env.example` for the full set.

## Development

```bash
npm run typecheck        # whole monorepo
npm test                 # unit tests, no infrastructure needed
npm run test:integration # lifecycle tests against Postgres (needs infra:up)
npm run test:all         # both
npm run db:status        # which migrations are applied
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
same amount is not owed twice.

`SETTLEMENT_DRIVER=evm` pays for real, by transferring an ERC-20:

```bash
SETTLEMENT_DRIVER=evm
SETTLEMENT_RPC_URL=<rpc endpoint>
SETTLEMENT_CHAIN_ID=<evm chain id>
SETTLEMENT_ASSET=<usdc contract, 0x…>
SETTLEMENT_PRIVATE_KEY=<the key that signs payouts, 0x…>
```

All four are required and none has a default, for the reason the paywall has no
network table: a wrong token contract is not a misconfiguration, it is funds
sent somewhere nobody controls. The chain id is checked against the one the RPC
actually serves before the first transfer, every transfer is simulated before it
is broadcast, and `CONFIRMED` is reported only after the receipt is read back —
a transfer that has not confirmed within the timeout is `BROADCAST`, and the
debt stays owed until something sees it land.

An address the driver cannot pay is a **skip with a reason**, printed by the
plan before anything is executed, rather than a failure partway through a split.
That case is real rather than theoretical: agent payees come from the wallet a
user connected through Privy, which is not guaranteed to be an EVM address.

The transfer path is executed in the test suite against a JSON-RPC server on
loopback, which signs a genuine transaction and reads the bytes back to check
the calldata. It has **not** yet moved funds on a real chain.

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
| `DataItem` never written | A deleted upstream pod orphans an old job's evidence trail |
| Web traffic shares one server-side key outside `/automation` | Jobs and agents still render under a shared identity; only automations are per-wallet |
| One oracle (`reppo:` sources only) | Price and on-chain predictions resolve as `UNRESOLVABLE` |
| No metrics or tracing | Cost, latency and failure rates are invisible |
| The `evm` settlement driver has never run on a real chain | Its transfer path is exercised against a mock RPC only; the first live sweep is still a first |
| x402 charges a flat fee | A one-agent job costs the same as a five-agent one |
| x402 has never settled | The challenge is issued; no payment has completed against a live facilitator |
| No automation tick loop | `evaluate` and `sweep` are called by hand; nothing polls for resolved jobs |
| No price adapter shipped | An automation cannot mark a position until `EXECUTION_PRICE_URL` points somewhere verified |

Deliberately **not** built: protocol token, DAO, governance, custom chain,
custom inference network, ZK infrastructure, cross-chain.

## Deploying

Two Fly apps from one image: `fly.toml` runs the gateway and the four lifecycle
workers in one process, `fly.web.toml` runs the site. Two apps rather than one
because Fly gives an app a single hostname, and the gateway needs a public one
of its own for SDK callers and x402 payers.

**Each app deploys from its own config.** A bare `fly deploy` reads `fly.toml`
and updates the gateway only, which is the most common way to ship a change and
then not see it on the site:

```bash
npm run deploy:api    # fly deploy --config fly.toml
npm run deploy:web    # fly deploy --config fly.web.toml
npm run deploy        # both, api first so migrations land before the site
```

The API goes first because its `release_command` runs `prisma migrate deploy`.

The datastore is not Fly's: Postgres is **Supabase**, and the queue lives inside
it via `pgmq`, so there is no Redis to provision, secure or pay for. Fly bills
only for the machines that run the processes.

```bash
fly apps create averis-api
fly apps create averis-web

fly secrets set --app averis-api \
  DATABASE_URL='<Supabase pooler, :6543, ?pgbouncer=true&sslmode=require&uselibpqcompat=true>' \
  DIRECT_DATABASE_URL='<Supabase direct, :5432, ?sslmode=require&uselibpqcompat=true>' \
  DATABASE_POOL_MAX='<budget / process count>' \
  API_KEYS='<root key>' \
  CORS_ORIGINS='https://averis-web.fly.dev'
fly deploy --config fly.toml

fly secrets set --app averis-web \
  AVERIS_API_KEY='<the same root key>' \
  AVERIS_API_URL='http://averis-api.internal:4000'
fly deploy --config fly.web.toml
```

`fly deploy` never creates an app, so `fly apps create` comes first — otherwise
it fails with `app not found`. App names are global to Fly; if one is taken,
rename it in the matching `fly.toml` too.

The site reaches the gateway over Fly's private network
(`AVERIS_API_URL=http://averis-api.internal:4000`), so that hop never leaves the
organisation. Both apps must be in the same org for that name to resolve.

### If you run Redis instead

The deployment above uses `QUEUE_DRIVER=pgmq` and needs no Redis at all. The
BullMQ driver stays in the codebase for deployments that already run one; what
follows applies only to those.

`fly redis create` provisions Upstash through Fly and bills per command, which
is the wrong meter for this workload. BullMQ keeps a *blocking* read open per
queue and re-issues it every few seconds; with four queues that is on the order
of a million commands a month with no jobs in the system at all. A free tier
metered by commands drains while the thing sits idle.

Pick one metered by memory instead — Redis Cloud's free tier is 30MB with
unlimited commands and no sleep, and 30MB is far more than this needs, because
`keepCompleted`/`keepFailed` in `packages/queue/src/bullmq.ts` cap the retained
history per queue.

Two properties are non-negotiable whichever provider you choose:

- **Real TCP, not HTTP/REST.** Upstash's REST endpoint and similar serverless
  Redis APIs cannot serve a blocking read, so BullMQ cannot run on them at all.
- **`rediss://`, and the password percent-encoded.** Managed Redis is TLS-only.
  `BullMQDriver` reads the scheme and enables TLS with SNI, which the shared
  hostnames these providers use require in order to present the right
  certificate.

`QUEUE_DRIVER=memory` removes the queue entirely, but it is only correct inside
a single process: the API would accept jobs that no worker ever sees. It is for
the demo and CI, never for a deployment.

### Why two Supabase connection strings

They are not interchangeable, and using one for both is the mistake that looks
like it works.

| Variable | Supabase string | Used by |
|---|---|---|
| `DATABASE_URL` | pooler (Supavisor), `:6543`, `?pgbouncer=true` | the app |
| `DIRECT_DATABASE_URL` | direct session, `:5432` | migrations |

Both need `sslmode=require&uselibpqcompat=true`, and a password that has been
percent-encoded. Supabase's pooler presents a certificate from a private CA,
and node-postgres ≥8.11 reads a bare `sslmode=require` as verify-full — so
without the compat flag every connection fails with `self-signed certificate in
certificate chain`, which reads like a network problem rather than a spelling
one. The flag is pg's own switch back to libpq's meaning of the word. To verify
the chain properly instead, download the project CA from Settings → Database →
SSL Configuration and use `sslmode=verify-full&sslrootcert=<path>` with no flag.

The app wants the pooler because it issues many short queries, and a direct
connection per machine would burn the project's connection budget. Migrations
want the session connection because a transaction-mode pooler may hand
consecutive statements to different backends, which a migration does not
survive. `prisma.config.ts` prefers `DIRECT_DATABASE_URL` automatically, so the
release command needs no override.

Two consequences worth knowing:

- **`DATABASE_POOL_MAX` is shared, not per process.** The API, each worker and
  the operator each hold their own pool against the same budget, so three
  processes at the default of 10 is already 30 connections. Lower it for
  Supabase — but derive it from process count, do not just pick a small number.
  Below this repository's own concurrency it does not slow things down, it
  breaks them: an interactive transaction that waits too long for a free
  connection is rolled back underneath itself and reports `Transaction already
  closed`, which points nowhere near the pool. Measured: at 5 the integration
  suite fails about one run in three.
- **`pg_advisory_xact_lock` must stay transaction-scoped.** The budget guard
  relies on it, and it is safe through a transaction pooler precisely because
  it is transaction scoped. A session-scoped `pg_advisory_lock` would not be.

Local development is unchanged: `npm run infra:up` still runs Postgres in
Docker, `DIRECT_DATABASE_URL` stays empty, and both resolve to the same string.
The integration tests still create and truncate their own `averis_test`
database there, which is why they are pinned to Docker rather than Supabase —
they would otherwise truncate tables in a hosted project.

Four things to get right, each of which fails quietly rather than loudly:

- **`REDIS_URL` must be a real TCP Redis.** BullMQ uses blocking commands; an
  HTTP/REST endpoint will not work.
- **`QUEUE_DRIVER=bullmq`.** The memory driver is only correct inside a single
  process — with it the API accepts jobs no worker will ever see.
- **Keep `prisma/migrations` complete.** `fly.toml` runs `prisma migrate
  deploy` as its release command, and against an incomplete directory it exits
  successfully having applied nothing — the app then starts on a half-built
  schema. Run `npx prisma migrate dev --name <what-changed>` after any schema
  change and commit the result; `npm run db:status` tells you where you stand.
- **Authoring a migration against Supabase needs `SHADOW_DATABASE_URL`.**
  `migrate dev` creates a scratch database with `CREATE DATABASE`, which hosted
  Postgres refuses. Point it at the local Docker instance; it holds no real
  data.

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
- [Automation](docs/automation.md) — trading policy, gates, breaker, why there is no live driver
- [Reppo integration](docs/reppo-integration.md) — verified endpoints, curation → evidence weight
- [Tracing](docs/tracing.md) — one trace across the gateway, the queue and the workers
