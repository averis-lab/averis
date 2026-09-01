# Automation

Turning intelligence into positions — and refusing to, most of the time.

An automation is a **consumer** of the protocol, not part of it. It reads jobs
the protocol resolved, applies a policy its owner set, and opens a position only
when the cohort cleared every gate. Nothing in `packages/protocol` knows the
`automations` table exists, and that boundary is what keeps Averis general: the
trading vertical is one client of the intelligence API, the same way the
operator is one client of the job engine.

```
Job RESOLVED ──▶ verdict ──▶ policy gates ──▶ driver ──▶ Position ──▶ exit sweep
                    │             │                          │
              confidence,    every gate            traces back to the job
              consensus,     recorded              that opened it
              cohort size    pass or fail
```

## What is deliberately not here

**No custody.** There is no key column, no wallet the server signs with, and no
place to paste an exchange API key. `Automation` holds a name, a policy and two
switches. A live driver, if one is ever written, signs in the owner's browser —
a database dump must never be enough to move someone's money.

**No live driver.** `EXECUTION_DRIVER` accepts `none` and `paper`. Setting the
mode to `LIVE` returns 501 with the reason. This is the same position
`SETTLEMENT_DRIVER` takes, for the same reason: an untested swap path
sitting beside code that has never executed a trade is the most dangerous thing
that can be in this repository, because it looks ready.

**No performance claims.** The dashboard shows realised P&L with its sample
size attached and says plainly when there are too few trades to mean anything.
A win rate from nine trades is not a track record.

## Who owns an automation

With `PRIVY_APP_ID` and `PRIVY_APP_SECRET` set, an automation belongs to the
**wallet that deployed it**, and every read is scoped to that wallet the same
way jobs are scoped to an account key.

The browser presents a Privy **identity token**; the gateway verifies its
signature with the app secret before believing a single field in it. That
distinction carries the whole design:

> A wallet address sent as a parameter is a claim anyone can make. An endpoint
> that trusts one has authentication in name only — knowing someone's address
> would be enough to act as them.

So the address is never taken from the client. It is read out of a token the
gateway has checked, in `apps/api/src/privy.ts`, and only then resolved to an
account.

| Piece | Location |
|---|---|
| Config, token shape, verifier | `apps/api/src/privy.ts` |
| JWT branch, wallet→account resolution | `apps/api/src/auth.ts` |
| Provider, connect button, gate | `apps/web/components/wallet.tsx` |
| HttpOnly cookie hop | `apps/web/lib/session.ts`, `apps/web/app/api/session/` |

Four decisions carry it:

- **Identity, not custody.** Averis asks for no key, holds none, and cannot
  sign. `embeddedWallets.createOnLogin` is `off`, because creating a wallet as a
  side effect of signing in is how a product that holds nothing starts holding
  something.
- **The DID is the person, the address is today's key.** `User.privyId` is the
  primary identity; someone who links a second wallet keeps their automations.
  A wallet already on an account with no DID is *claimed* on first verified
  login, because proving control of that address is exactly the authentication
  that account was waiting for.
- **`getUser({ idToken })`, not `getUserById`.** The former verifies locally;
  the latter is an authenticated, rate-limited round trip. Putting that in the
  auth hook would make Privy's availability a dependency of every read.
- **Half-configured throws at startup.** An app id without a secret renders a
  login button whose tokens the gateway then rejects one at a time.

The token reaches the server side of the web app through an **HttpOnly** cookie
set by `POST /api/session` — stricter than where it came from, since page
scripts cannot read it back. Nothing in the web app verifies it; it is forwarded
to the gateway, which does. A forged cookie buys a 401 and nothing else.

When wallet login is on and nobody is connected, the automation pages are **not
fetched at all** rather than fetched and hidden. Reading the list with the web
app's shared key would show one operator another operator's book.

With Privy unset the gateway keeps its previous behaviour, so the CLI, the demo
and the workers still work unchanged.

## The policy

Every field in `TradePolicySchema` is a ceiling checked **before** a position
opens, never a target measured after — the trading counterpart of
`@averis/budget`, which bounds what the protocol may spend thinking.

### The intelligence gate

| Gate | Default | Why |
|---|---|---|
| `minConfidence` | 0.65 | Merged confidence of the result |
| `minConsensus` | 0.6 | Inter-agent agreement, **scored separately** |
| `minAgents` | 3 | Agents that actually finished, not the cohort requested |
| `maxUnsupportedClaims` | 0 | A claim citing evidence the runtime never retrieved |
| `maxDisagreements` | 1 | Contested topics — capped, not banned |

Confidence and consensus are two floors rather than one blended threshold
because the protocol reports them separately, and for the same reason: **a
cohort can be confidently split.** A single number would let a job where every
agent disagreed loudly but certainly clear the bar.

`maxDisagreements` allows some dissent on purpose. Refusing every contested job
would quietly select for the cohorts that agree most, which is the correlated
error multi-agent analysis exists to avoid.

### Why there is no symbol allowlist

An allowlist is the right primitive for equities and it does not survive contact
with memecoins, where every candidate is a token contract that did not exist an hour ago.
The gate moves instead to the thing Averis can actually vouch for — a verdict
that cleared the floors above — plus one position per token and a per-token
cooldown, so a single trending token cannot become the whole book. A blocklist
remains, but it is a mop rather than a gate: it can only name what someone has
already found.

## Failing closed

Three defaults each refuse rather than approximate:

| Missing | Behaviour |
|---|---|
| No execution driver | `NoneDriver` throws. Nothing opens |
| No price source | `quote()` returns null. Nothing opens, nothing marks |
| Unknown driver name | Startup throws, naming the value |

The last one matters more than it looks. Falling back to `none` on a typo would
hide the mistake until the day it was corrected, at which point everything goes
live at once.

A price that cannot be observed is never substituted with the last known mark or
the entry price. A book marked to numbers nobody saw produces an equity curve
that is fiction, and every decision downstream inherits it.

## The circuit breaker is derived, not stored

`deriveBreaker` recomputes from trade history on every check. There is no
persisted `paused` flag to flip.

This mirrors how reputation is handled: snapshots are recomputed from full
history rather than incremented, so a rule change applies retroactively and any
past decision can be replayed. A stored boolean drifts from the history that
justified it, and once it has, there is no way to tell which of the two is
wrong.

The cost is that an automation whose first trades all lose trips the breaker and
can never trade its way out. `breakerResetAt` is the escape hatch — it moves the
window forward **without deleting the trades that caused the pause**, so the
record of why it tripped survives the reset.

## Two switches, never one

| Switch | Says |
|---|---|
| `active` | Whether the automation may open new positions |
| `mode` | Whether those positions spend real money |

Collapsing them would make going live a side effect of a button an operator
presses many times a day.

`active` gates **new entries only**. An open position keeps being marked and
exited by its own rules after a stop, because walking away from risk already on
the book is worse than continuing to manage it. The UI says so on the button.

## Exactly one position per job

`Position.jobId` is unique across the table, not merely per automation. Queues
deliver at least once — the protocol treats that as normal rather than
exceptional — so the same verdict arriving twice must not become two positions.
The constraint is what makes this true under concurrency, not the application
code around it; a redelivered evaluation loses the race and returns the existing
position. It is the same defence `Transaction.rewardId` gives settlement.

Exits are claimed the same way: `updateMany` conditional on still being `OPEN`,
so two sweeps racing cannot both book a close.

## Exits, in severity order

`planExit` checks stop loss, then trailing stop, then take profit, then the hold
limit. A move that trips both the stop and the target is booked as a **loss**.
Assuming the favourable fill would make every backtest of a policy optimistic in
exactly the cases that decide whether it works.

The peak is persisted on every mark, not only on exit: a trailing stop that
recomputed its reference from stored marks would forget any high it did not
happen to close on.

## Why refusals are recorded

`AutomationEvent` writes a row for refusals as well as actions, with the binding
gate and every gate that was evaluated. "Why did nothing trade today" is the
question an operator actually asks, and it is unanswerable from a table that
only remembers the trades that happened.

`planEntry` evaluates every gate even after one has failed, for the same reason.
Returning at the first failure would answer "confidence too low" for a job that
also had no cohort and was already held — three different fixes, one of them
shown.

## What this is for

Averis's own documented gap is that `accuracy` and `calibration` sit at the
neutral prior for every agent, because no prediction has matured yet. A position
is a prediction with a deadline and an objective resolver.

Which makes paper mode the point rather than a lesser version of it: it closes
the falsification loop without a dollar moving. The safest mode is also the one
that produces the most evidence.

## Layout

```
packages/execution/
  policy.ts     TradePolicy schema, defaults, stored-policy parsing
  plan.ts       planEntry, planExit, deriveBreaker — pure, no database
  drivers.ts    none (refuses) | paper. No live driver
  prices.ts     PriceSource; null by default, HTTP by configuration
  engine.ts     the half that touches Postgres
apps/api/src/routes/automations.ts
apps/web/app/(app)/automation/
tests/execution.test.ts
```

`plan.ts` imports no database, no RPC client and no clock it was not handed —
the same split `settlement-plan.ts` makes, so every rule that decides whether
money moves can be tested without money, a chain or a schema.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/automations` | List, with derived breaker state and driver status |
| POST | `/v1/automations` | Deploy — stopped, in paper mode |
| GET | `/v1/automations/:id` | One automation and its stats |
| PATCH | `/v1/automations/:id` | Update name, capabilities, policy |
| POST | `/v1/automations/:id/active` | Start or stop |
| POST | `/v1/automations/:id/mode` | PAPER or LIVE — LIVE returns 501 |
| POST | `/v1/automations/:id/reset-breaker` | Move the breaker window forward |
| POST | `/v1/automations/:id/evaluate` | Run one resolved job past the policy |
| POST | `/v1/automations/:id/sweep` | Mark open positions and close what fired |
| GET | `/v1/automations/:id/positions` | Positions, each linked to its job |
| GET | `/v1/automations/:id/events` | Audit trail, refusals included |

Reads are scoped by owner the same way jobs are: another account's automation is
a **404, not a 403**, because a 403 confirms the id exists.

## Gaps

| Gap | Consequence |
|---|---|
| No tick loop | `evaluate` and `sweep` are called by hand or by a caller you write; nothing polls |
| No price adapter shipped | `EXECUTION_PRICE_URL` must point at an endpoint you verified |
| No live driver | Positions are bookkeeping; nothing settles on-chain |
| Paper fills ignore slippage and fees | A modelled figure would be indistinguishable from a measured one |
| Policy edits are not versioned | Unlike `Datanet.rubric`, an old decision cannot be replayed against the policy that produced it |
