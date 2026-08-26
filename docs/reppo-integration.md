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

Only the **public, unauthenticated** read surface. The intelligence layer never
needs custody of a user's Privy session.

| Method | Path | Used for |
|---|---|---|
| GET | `/public/subnets` | Datanet discovery |
| GET | `/public/subnets/{id}` | Datanet detail, curation oracle |
| GET | `/public/pods` | Evidence retrieval, search |
| GET | `/public/pods/{podId}` | Single item lookup |

Base URL: `https://reppo.ai/api/v1` (`REPPO_API_BASE_URL`).

Authenticated `/me/*` endpoints (publishing, minting, voting) are **not** used.
`REPPO_PRIVY_TOKEN` and `REPPO_AGENT_API_KEY` exist in the adapter for future
write flows and are unset by default.

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
unreachable, so a transient upstream outage does not fail every in-flight job.

## Settlement note

Reppo settles on Base (`chainId: 8453`). This protocol's escrow layer targets
an EVM chain in USDC. They are independent layers — the intelligence protocol reads
Reppo data but does not transact on Reppo's chain.
