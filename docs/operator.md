# Autonomous operator

An operator is a node that runs unattended: it discovers jobs, decides which
are worth taking, verifies it can afford them, runs the agents, and monitors
outcomes.

```
discover ─▶ strategy ─▶ budget ─▶ execute ─▶ evaluate ─▶ consensus ─▶ reputation ─▶ rewards
```

## Configuration

`apps/operator/operator.yaml`:

```yaml
operator:
  name: alpha-node

strategy:
  domains: [crypto, defi, markets, research]
  min_reward: 0.5
  max_required_confidence: 0.9
  max_concurrent_jobs: 5
  cadence: 30m
  min_time_to_deadline_ms: 60000

budget:
  daily: 50
  weekly: 250
  per_job: 5
  per_agent: 2
  transaction_reserve: 5
```

Validation is **strict and fails at startup**. `per_job > daily` or
`transaction_reserve >= daily` refuses to boot. A node that runs unattended
with a silently defaulted budget is the failure this project treats as
dangerous — better to refuse to start than to spend on a typo. A malformed
`cadence` throws rather than defaulting, so a node never polls at a rate its
operator did not choose.

```bash
npm run dev:operator
npx tsx scripts/operator-tick.ts --seed   # one cycle, with visible filtering
```

## Strategy vs budget

These are deliberately separate concerns:

- **Strategy** answers *is this job worth doing* — domain fit, reward floor,
  achievable confidence, deadline headroom, capacity.
- **Budget** answers *can this be afforded right now*.

Conflating them would let an operator with spare budget take work it should
decline, and an operator with good strategy overspend.

`max_required_confidence` deserves note: taking a job whose confidence bar is
out of reach burns budget for a result the protocol will reject. Declining is
the correct move.

Jobs beyond capacity are reported as `AT_CAPACITY` rather than silently
dropped, so the operator log explains why a viable job was not taken.

## Budget guard

The ordering is the entire point:

```
Job ─▶ Estimate cost ─▶ Budget validation ─▶ Policy validation ─▶ Execute
```

Nothing executes before its cost is committed to the ledger.

**`check` is not a gate.** It evaluates limits without committing, which is
fine for previews — but between checking and spending, another worker can
commit the same headroom. The only sanctioned path to paid work is `reserve`,
which validates and commits **atomically**, or `withBudget`, which wraps
execution so "execute then account" cannot be written by accident.

Atomicity is real, not aspirational: `reserve` holds a lock for the duration
(an in-process `KeyedMutex`, or a Postgres advisory lock through
`SpendLedger.withLock` when several worker processes contend for one
operator's budget). Without it, ten concurrent agent runs each read the same
headroom and overrun the budget tenfold — which is exactly what a job fanning
out to a cohort does.

Other properties:

- Committed spend counts `actual ?? reserved`, so an unreconciled reservation
  is money already spoken for.
- **Failed work keeps its committed estimate.** A crash-looping agent must not
  be able to spend for free.
- `transaction_reserve` is held back from inference, so analysis cannot consume
  the funds needed to settle rewards already promised.
- A nonsensical estimate (`NaN`, `Infinity`, negative) is rejected rather than
  treated as free.

## Transaction safety

Agents never touch private keys. The intended path for any on-chain action:

```
Agent ─▶ Intent ─▶ Policy engine ─▶ Budget guard ─▶ Simulation ─▶ Wallet ─▶ Signature ─▶ Broadcast
```

The `Transaction` model records `intent` and `simulation` before a `signature`
exists, so the gate is representable in data. Settlement is **not enabled in
the MVP** (`SETTLEMENT_DRIVER=none`); rewards are recorded as `PENDING` with
their basis, and nothing is broadcast.

## Operating notes

- Run several operators against one Redis and Postgres; BullMQ distributes work
  and the advisory lock keeps their budgets independent and correct.
- Set `LLM_PROVIDER` and the matching API key to move off the mock provider,
  or bind providers per agent in the registry.
- `RESOLUTION_SWEEP_MS` controls how often due predictions are resolved. The
  sweep is time-driven rather than queue-driven because a deadline can be weeks
  out, and holding a delayed queue message that long is the worse failure mode.
