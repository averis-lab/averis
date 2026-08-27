# Reppo integration

Reppo is an **external data network**. This protocol reads from it and never
reimplements it: no Datanet mechanism, no competing curation market, no
duplicated voting or emissions logic.

## Sources of truth

Endpoints and field names below were taken from the official documentation
**and verified against live responses** during implementation:

- <https://docs.reppo.ai/api/overview.md>
- <https://docs.reppo.ai/api/datanets.md>
- <https://docs.reppo.ai/api/pods.md>
- <https://docs.reppo.ai/concepts/datanets.md>
- <https://github.com/Reppo-Labs>

## Vocabulary mapping

Reppo's documentation and its API use different words for the same things.
The adapter is the only place that knows this.

| Reppo docs | Reppo API | This protocol |
|---|---|---|
| Datanet | `subnet` | `Datanet` |
| Pod | `pod` | `DataItem` |
| veREPPO vote volume | `upVoteVolume` / `cumulativeUpVotesVolume` | `curation.approvalRate` → `qualityScore` |

## Endpoints used

The adapter reads and never writes. With no credential configured it uses the
**public, unauthenticated** surface alone — the default, and the whole
behaviour of the reference deployment.

| Method | Path | Used for |
|---|---|---|
| GET | `/public/subnets` | Datanet discovery |
| GET | `/public/subnets/{id}` | Datanet detail, curation oracle |
| GET | `/public/pods` | Evidence retrieval, search |
| GET | `/public/pods/{podId}` | Single item lookup |

Base URL: `https://reppo.ai/api/v1` (`REPPO_API_BASE_URL`).

## Authenticated reads

`/public/subnets` lists only **active** datanets, so a datanet that is
permissioned or still unpublished appears nowhere on the public surface. Set
`REPPO_PRIVY_TOKEN` (the documented Privy session cookie) or
`REPPO_AGENT_API_KEY` and the adapter additionally reads:

| Method | Path | Used for |
|---|---|---|
| GET | `/me/subnets` | Owned datanets, including unpublished ones |
| GET | `/me/subnets/{id}` | Datanet detail when the public read 404s |
| GET | `/me/pods` | Owned pods, filtered locally per datanet |
| GET | `/me/pods/{podId}` | Single item lookup when the public read 404s |

Every one of these is behind a credential check, so an unconfigured deployment
issues exactly the requests it issued before this existed.

Merge rules, and why they are what they are:

- **Owned datanets are listed first, not appended.** They exist nowhere else in
  the response, so trailing them behind a full page of public results would let
  `limit` silently drop the only rows the credential was configured to reach.
- **`/me/*` has no documented `search`,** so the caller's term is applied
  locally rather than ignored.
- **The datanet filter still applies.** `/me/pods` returns pods across every
  datanet at once, so a datanet-scoped read filters them the same way it
  already filters the advisory `filters[subnet]` response.

### What this does not reach

`/me/*` is scoped to the **identity**, not to a datanet: it returns the
datanets that identity owns and the pods it created. The documented API exposes
no "every pod in datanet X" read for a datanet the credential does not own, so
a permissioned datanet is readable to the extent the configured identity owns
it — not in general. An unminted draft also carries no curation votes, so it
lands on the neutral 0.5 prior rather than arriving weighted as good evidence
merely because it is private.

The credential is also still **process-wide**, read from the environment at the
composition root. Per-tenant custody of Reppo credentials is a separate piece of
work; `ReppoHttpProvider` takes its credential as constructor config precisely
so that becomes a wiring change rather than a rewrite.

Unlike the public schemas, these envelopes were **not verified against live
responses** — that needs a Privy session for a real account. They accept either
the documented `{"data": {"subnets": [...]}}` shape or a bare `{"data": [...]}`
array and degrade to an empty list instead of throwing.

### A rejected credential does not degrade

`ReppoAuthError` (401/403) is deliberately distinct from every other upstream
failure, and `withFixtureFallback` rethrows it instead of recovering. The
fixtures are recordings of the *public* surface, so answering an access failure
with them would hand back public data dressed as the permissioned corpus, and
it would surface as a thin result rather than as the misconfiguration it is.

Write flows (publishing, minting, voting) remain unused.

## Undocumented behaviour found by probing

Two things the docs do not state, both worked around in
`packages/reppo-adapter/src/http-provider.ts`:

1. **`limit` is not honoured on `/public/pods`.** A `limit=40` request returned
   3 240 rows. The adapter enforces the limit client-side.
2. **`filters[subnet]` is advisory.** The adapter re-applies the datanet filter
   locally, so a datanet-scoped job can never draw evidence from a datanet it
   did not select.

Also: every response is wrapped in a `{"data": {...}}` envelope with no
pagination metadata (page exhaustion is detected by a short page), and
`tokenId` is a string on subnets but a number on pods. Wire schemas are lenient
about absent fields — Reppo can add fields at any time, and a strict parse
would take the whole intelligence layer down with it.

## Turning curation into evidence weight

Reppo curation is **stake-weighted vote volume**, not a count. A pod with 3 500
volume and one with 500 000 volume can both show 100% approval; they are not
equally trustworthy.

```
approval   = up / (up + down)                       # 0.5 when unvoted
confidence = log10(1 + volume) / log10(1 + saturation)
quality    = 0.5 + (approval - 0.5) * confidence
```

A thinly-voted perfect score shrinks toward 0.5 (no information); a heavily
voted one converges on its true approval rate. That `quality` becomes the
evidence's `reliability`, which flows into evaluation and consensus weighting —
so an agent citing well-curated sources genuinely outscores one citing noise.

A **banned pod scores 0 regardless of its votes.**

## Domain inference

Reppo does not publish machine-readable domain tags, but capability-aware agent
selection needs something to match on. `inferDomains` applies a keyword lexicon
over the datanet's own name and description. It is a documented heuristic, not
a claim of semantic understanding, and it never returns an empty tag set — an
untagged datanet would be invisible to matching, which is worse than being
broadly tagged.

## The abstraction boundary

Everything above the adapter depends on `DataProvider`, never on Reppo:

```ts
interface DataProvider {
  readonly name: string;
  listDatanets(page?): Promise<Datanet[]>;
  getDatanet(id): Promise<Datanet | null>;
  listData(datanetId, page?): Promise<DataItem[]>;
  getData(dataId): Promise<DataItem | null>;
  searchData(query: DataQuery): Promise<DataItem[]>;
}
```

Supporting another curated data network means writing one more implementation.

## Offline mode

`ReppoFixtureProvider` serves **genuine recorded payloads** (12 datanets, 197
pods in `packages/reppo-adapter/fixtures/`), not invented data — so schema
drift fails the tests rather than passing against a fiction. Set
`REPPO_PROVIDER=fixture` for air-gapped runs and CI.

`withFixtureFallback` additionally degrades to fixtures when the live API is
unreachable, so a transient upstream outage does not fail every in-flight job —
with the one exception above: a rejected credential is raised, not papered
over.

## Settlement note

Reppo settles on Base (`chainId: 8453`). This protocol's escrow layer targets
an EVM chain in USDC. They are independent layers — the intelligence protocol reads
Reppo data but does not transact on Reppo's chain.
