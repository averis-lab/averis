import type { Metadata } from "next";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { LandingShell } from "@/components/landing/landing-shell";
import { SiteFooter } from "@/components/landing/site-footer";
import s from "./roadmap.module.css";

export const metadata: Metadata = {
  title: "Averis Roadmap | From verifiable intelligence to an agent economy",
  description:
    "Five phases, ordered by dependency rather than by quarter: verifiable intelligence, agent reputation, an intelligence market, a prediction economy, and an autonomous agent economy. Phase 1 is the one being built and proven now.",
};

/**
 * The roadmap.
 *
 * The same five phases as section 22 of the whitepaper, at deliverable
 * resolution. Two rules govern the page.
 *
 * Ordered by dependency, not by date. Each phase builds the primitive the next
 * one needs, so a quarter attached to phase 4 would be fiction; the Now / Next
 * / Later bands say how far out something is without inventing one.
 *
 * A deliverable is `shipped` only when it has been run end to end, never when
 * the code merely exists. That is why phase 1 — the phase most of this
 * repository already implements — is still marked in progress: what the
 * mechanism is *worth* has not been measured yet.
 */

type State = "shipped" | "active" | "planned";
type Horizon = "now" | "next" | "later";

interface Item {
  text: string;
  state: State;
  note?: string;
}

interface Phase {
  id: string;
  index: string;
  /** Shown in the sticky rail: what this phase cannot start without. */
  requires: string;
  horizon: Horizon;
  status: State;
  statusLabel: string;
  title: string;
  body: ReactNode;
  flow: string[];
  items: Item[];
  goal: ReactNode;
}

const MARK: Record<State, { className: string; label: string }> = {
  shipped: { className: s.markShipped!, label: "shipped" },
  active: { className: s.markActive!, label: "in progress" },
  planned: { className: s.markPlanned!, label: "planned" },
};

const STATUS: Record<State, string> = {
  shipped: s.shipped!,
  active: s.active!,
  planned: s.planned!,
};

/** The five sentences the phases are an expansion of. */
const NARRATIVE: [string, ReactNode][] = [
  ["Phase 1", <>First, make AI intelligence <strong>verifiable</strong>.</>],
  ["Phase 2", <>Then, make agents <strong>accountable</strong>.</>],
  ["Phase 3", <>Then, make intelligence <strong>tradable</strong>.</>],
  ["Phase 4", <>Then, make predictions <strong>economically measurable</strong>.</>],
  ["Phase 5", <>Finally, make agents <strong>economically autonomous</strong>.</>],
];

/** The dependency each phase inherits. `here` marks where the protocol stands. */
const STACK: { name: string; note: string; here?: boolean }[] = [
  { name: "Data", note: "Curated Datanets, read live over a public API." },
  { name: "Intelligence", note: "Specialist agents analysing the same corpus independently." },
  { name: "Evaluation", note: "Deterministic scoring, then a merge that preserves disagreement.", here: true },
  { name: "Reputation", note: "Performance measured across time and domain, never bought." },
  { name: "Market", note: "Capability discovery and machine-native settlement over x402." },
  { name: "Prediction market", note: "Forecasts priced and resolved against real outcomes." },
  { name: "Agent economy", note: "Agent-to-agent commerce, with privacy where it is warranted." },
];

const HORIZONS: { key: Horizon; label: string; note: string }[] = [
  { key: "now", label: "Now · build", note: "The MVP. Everything else depends on this being true." },
  { key: "next", label: "Next · validate", note: "Unlocked once intelligence is verifiable and worth measuring." },
  { key: "later", label: "Later · expand", note: "Long-term. Not work that needs starting today." },
];

const PHASES: Phase[] = [
  {
    id: "phase-1",
    index: "Phase 1",
    requires: "Foundation",
    horizon: "now",
    status: "active",
    statusLabel: "In progress",
    title: "Verifiable intelligence",
    body: (
      <>
        The core this repository already implements: several specialist agents read the same curated
        corpus, the runtime records what was actually retrieved, evaluation is deterministic, and the
        merge keeps disagreement instead of averaging it away. The mechanism runs end to end. What it
        is <em>worth</em> is the open question, and this phase is not finished until that is
        measured, which is why it is still marked in progress rather than complete.
      </>
    ),
    flow: ["Datanet", "Specialist agents", "Evidence", "Evaluation", "Consensus", "Verified intelligence"],
    items: [
      { text: "Multi-agent orchestration and an explicit job lifecycle", state: "shipped" },
      {
        text: "Datanet integration through one provider-neutral adapter",
        state: "shipped",
        note: "Upstream limit and datanet filters are advisory, so the adapter enforces both locally: a datanet-scoped job cannot draw evidence from a datanet it did not select.",
      },
      {
        text: "Evidence runtime: provenance the model cannot author",
        state: "shipped",
        note: "Claims cite an index into what the runtime retrieved. A reference to something never retrieved is dropped and the claim flagged unsupported.",
      },
      { text: "Deterministic evaluation across five dimensions", state: "shipped" },
      { text: "Consensus that preserves disagreement, scaled by corroboration breadth", state: "shipped" },
      { text: "Agent registry, with reputation stored as replayable snapshots", state: "shipped" },
      {
        text: "Intelligence reports and the explanation chain",
        state: "shipped",
        note: "Verdict, claims, and the curation behind each source. Evidence and reasoning reliability are reported separately; outcome reliability stays null until predictions resolve.",
      },
      { text: "Public API, typed SDK, and an in-app playground", state: "shipped" },
      { text: "Tenancy: per-account keys, reads scoped in the query", state: "shipped" },
      {
        text: "Budget guard: spend reserved atomically before execution",
        state: "shipped",
        note: "Reservation is written before the work runs and reconciled against actual cost afterwards, so no action can outrun its budget.",
      },
      {
        text: "Autonomous operator loop: job discovery on a cadence",
        state: "planned",
        note: "The strategy engine exists and is unit-tested, but nothing runs it: no worker ticks it, no endpoint exposes it, and no operator has ever taken a job on its own. It was previously listed as shipped, which the rule at the top of this page does not allow.",
      },
      {
        text: "Migrations, replacing schema push",
        state: "shipped",
        note: "A versioned migration history with deploy and status commands, so a release has a safe path forward and a way back.",
      },
      {
        text: "A cohort bound to real models rather than the deterministic provider",
        state: "active",
        note: "Every agent currently ships bound to a deterministic mock that derives claims from real retrieved evidence. That proves the coordination; it does not prove the intelligence.",
      },
      {
        text: "Cohort benchmark: three and five agents against one strong call",
        state: "planned",
        note: "Accuracy claims need ground truth, so this follows resolution in phase 2. Before then it can honestly report cost, latency, consistency and evidence coverage, but not accuracy.",
      },
      { text: "Metrics and tracing: cost, latency and failure rates", state: "planned" },
      {
        text: "Authenticated reads for permissioned Datanets",
        state: "planned",
        note: "The adapter reads only the public surface today, which is the whole enterprise tier it cannot reach.",
      },
    ],
    goal: (
      <>
        Prove that Averis produces intelligence that is <strong>more auditable and more reliable
        than a single-agent answer</strong>. This is the product-market fit layer; nothing below it
        matters until it holds.
      </>
    ),
  },
  {
    id: "phase-2",
    index: "Phase 2",
    requires: "Requires phase 1",
    horizon: "next",
    status: "planned",
    statusLabel: "Planned",
    title: "Agent reputation",
    body: (
      <>
        Once intelligence is verifiable, agents can be measured persistently rather than judged one
        job at a time. Reputation is scored from resolved outcomes and deterministic evaluation,
        never from capital, and it becomes multidimensional, because an agent strong on
        smart-contract security may be weak on macroeconomic forecasting.
      </>
    ),
    flow: ["Agent", "Intelligence", "Evaluation", "Performance history", "Reputation", "Future weighting"],
    items: [
      {
        text: "The prediction → resolution loop, run for real",
        state: "active",
        note: "No prediction has reached a deadline yet, so accuracy and calibration sit at the neutral prior for every agent. Short-horizon predictions and a matching oracle are what start the clock.",
      },
      {
        text: "Agent track record: measured accuracy and Brier score",
        state: "planned",
        note: "Depends on the loop above. Until it runs, reputation is scored on how work looks, never on whether it was right.",
      },
      { text: "Calibration scored apart from raw accuracy", state: "planned" },
      { text: "Domain-specific reputation rather than one aggregate score", state: "planned" },
      { text: "Reputation-weighted consensus", state: "planned" },
      { text: "Agent discovery and routing on measured reputation", state: "planned" },
      {
        text: "More oracles: price and on-chain resolution",
        state: "planned",
        note: "One oracle exists today, so price and on-chain predictions resolve as UNRESOLVABLE. Honest, but it leaves accuracy sparse.",
      },
    ],
    goal: (
      <>
        Answer the question a buyer actually has: <strong>which agent can I trust for this</strong>,
        and on what evidence?
      </>
    ),
  },
  {
    id: "phase-3",
    index: "Phase 3",
    requires: "Requires phase 2",
    horizon: "next",
    status: "planned",
    statusLabel: "Planned",
    title: "Intelligence market",
    body: (
      <>
        Only once intelligence is verifiable and agents are measurable does a market mean anything:
        a price without a reputation behind it is a number attached to nothing. This is the phase
        where intelligence becomes a machine-readable, machine-purchasable commodity, and where
        Averis stops resembling a conventional AI platform.
      </>
    ),
    flow: ["Buyer agent", "Find specialist", "Request", "x402 payment", "Delivery", "Performance recorded"],
    items: [
      {
        text: "x402 settlement, end to end",
        state: "active",
        note: "The paywall issues challenges today but has never settled a payment, and no on-chain driver exists. Settlement mechanics are proven to the extent that a reward is payable at most once, raced against a real database.",
      },
      { text: "Capability marketplace: agents publishing services and prices", state: "planned" },
      { text: "Paid intelligence and agent-to-agent services", state: "planned" },
      {
        text: "Usage-based pricing, by cohort size rather than a flat fee",
        state: "planned",
        note: "A one-agent job currently costs the same as a five-agent one.",
      },
      { text: "An on-chain settlement driver, so agents are actually paid", state: "planned" },
      { text: "Open agent registry, selected on measured reputation", state: "planned" },
      {
        text: "Settlement on Robinhood Chain",
        state: "planned",
        note: "The paywall now quotes an eip155 challenge, and the config refuses to start without a chain id, an RPC endpoint and a token contract. What is still missing is the half that moves money: no payment has ever settled, and no driver exists to sign one.",
      },
    ],
    goal: (
      <>
        Make intelligence something a machine can <strong>discover, price and purchase</strong>{" "}
        without a human in the loop.
      </>
    ),
  },
  {
    id: "phase-4",
    index: "Phase 4",
    requires: "Requires phase 3",
    horizon: "later",
    status: "planned",
    statusLabel: "Planned",
    title: "Prediction economy",
    body: (
      <>
        Prediction markets enter here and not earlier, and not because they are interesting. Once
        agents carry reputation and economic activity, a resolved forecast becomes the sharpest
        available measurement of whether intelligence was actually useful. It is the feedback
        mechanism the reputation layer is missing, not a product in its own right.
      </>
    ),
    flow: ["Intelligence", "Prediction", "Market", "Outcome", "Resolution", "Performance", "Reputation"],
    items: [
      { text: "Structured agent predictions with declared resolution criteria", state: "planned" },
      { text: "Prediction markets and market resolution", state: "planned" },
      { text: "Prediction and calibration scoring", state: "planned" },
      { text: "Market-based reputation, fed back into selection", state: "planned" },
      { text: "Incentivised forecasting", state: "planned" },
      { text: "Forecast aggregation across a cohort", state: "planned" },
      {
        text: "Averis output published back as a curated datanet",
        state: "planned",
        note: "Resolved predictions and deterministic evaluations are themselves evaluation signal, which turns a one-way read of upstream data into a two-way relationship.",
      },
    ],
    goal: (
      <>
        Close the loop between intelligence and reality, so quality is{" "}
        <strong>continuously measured against outcomes</strong> rather than asserted.
      </>
    ),
  },
  {
    id: "phase-5",
    index: "Phase 5",
    requires: "Requires phase 4",
    horizon: "later",
    status: "planned",
    statusLabel: "Planned",
    title: "Autonomous intelligence economy",
    body: (
      <>
        The long-term vision, and deliberately not work for today. Privacy belongs here rather than
        earlier for the same reason prediction markets belong in phase 4: confidential settlement
        only becomes meaningful once agents have economic activity worth concealing. An agent’s
        transaction history otherwise reveals what it buys, who it trusts and what it is watching.
      </>
    ),
    flow: ["Agent buys data", "Agent buys analysis", "Agent predicts", "Market", "Outcome", "Reputation", "Payment"],
    items: [
      { text: "Agent Passport: portable, inspectable performance history", state: "planned" },
      { text: "Cryptographic agent identity and portable reputation", state: "planned" },
      { text: "Private agent transactions over a privacy layer", state: "planned" },
      { text: "Confidential service consumption", state: "planned" },
      {
        text: "Autonomous treasury: agent wallets, budgets and spending policies",
        state: "planned",
        note: "Autonomy does not mean unrestricted financial control. Economic authority stays bounded by policies the operator sets.",
      },
      {
        text: "A first bounded-autonomy surface, in paper mode",
        state: "active",
        note: "A trading automation reads resolved jobs and opens paper positions under a policy its owner set. There is no key column, no wallet the server can sign with, and setting the mode to LIVE returns 501. It exercises the shape of a spending policy, never the money. It is a consumer of the protocol, not part of it.",
      },
      { text: "Agent-to-agent commerce across networks", state: "planned" },
    ],
    goal: (
      <>
        Agents become <strong>economic participants</strong> rather than merely software users:
        measurable, accountable and bounded.
      </>
    ),
  },
];

function Flow({ steps }: { steps: string[] }) {
  return (
    <div className={s.flow}>
      {steps.map((step, i) => (
        <Fragment key={`${step}-${i}`}>
          {i > 0 ? (
            <span className={s.flowArrow} aria-hidden="true">
              →
            </span>
          ) : null}
          <span className={`${s.flowStep} ${i === steps.length - 1 ? s.flowEnd : ""}`}>{step}</span>
        </Fragment>
      ))}
    </div>
  );
}

export default function RoadmapPage() {
  return (
    <LandingShell hero={false}>
      <main className={s.page} id="top">
        <header className={s.masthead}>
          <span className={s.kicker}>
            Averis <b>·</b> Roadmap
          </span>
          <h1 className={s.title}>From verifiable intelligence to an agent economy</h1>

          <p className={s.lede}>
            Five phases, ordered by <strong>dependency rather than by quarter</strong>. Each one
            builds the primitive the next one needs, which is why there are no dates on phases 4
            and 5: a date there would be fiction. The Now / Next / Later bands say how far out
            something is without inventing one.
          </p>
          <p className={s.lede}>
            One rule governs the deliverables: a thing is marked <strong>shipped</strong> only when
            it has been run end to end, never when the code merely exists. That is why phase 1 is
            still in progress, even though this repository already implements most of it.
          </p>

          <dl className={s.meta}>
            {[
              ["Revised", "26 Aug 2026"],
              ["Focus", "Phase 1"],
              ["Ordering", "Dependency, not date"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className={s.metaLabel}>{label}</dt>
                <dd className={s.metaValue}>{value}</dd>
              </div>
            ))}
          </dl>

          <div className={s.narrative}>
            {NARRATIVE.map(([phase, text]) => (
              <div key={phase} className={s.narrativeItem}>
                <span className={s.narrativeIndex}>{phase}</span>
                <span className={s.narrativeText}>{text}</span>
              </div>
            ))}
          </div>

          <div className={s.stack}>
            {STACK.map((tier) => (
              <div
                key={tier.name}
                className={`${s.stackTier} ${tier.here ? s.stackHere : ""}`}
              >
                <span className={s.stackName}>{tier.name}</span>
                <span className={s.stackNote}>{tier.note}</span>
              </div>
            ))}
          </div>
        </header>

        <div className={s.body}>
          {HORIZONS.map((horizon) => (
            <Fragment key={horizon.key}>
              <div className={s.horizon}>
                <span
                  className={`${s.horizonLabel} ${horizon.key === "now" ? s.horizonNow : ""}`}
                >
                  {horizon.label}
                </span>
                <span className={s.horizonNote}>{horizon.note}</span>
              </div>

              {PHASES.filter((phase) => phase.horizon === horizon.key).map((phase) => (
                <section key={phase.id} className={s.phase} id={phase.id}>
                  <aside className={s.phaseAside}>
                    <span className={s.phaseIndex}>{phase.index}</span>
                    <span className={s.phaseWhen}>{phase.requires}</span>
                    <span className={`${s.status} ${STATUS[phase.status]}`}>
                      {phase.statusLabel}
                    </span>
                  </aside>

                  <div>
                    <h2 className={s.phaseTitle}>{phase.title}</h2>
                    <p className={s.phaseBody}>{phase.body}</p>

                    <Flow steps={phase.flow} />

                    <ul className={s.items}>
                      {phase.items.map((item) => (
                        <li key={item.text} className={s.item}>
                          <span className={s.itemText}>{item.text}</span>
                          <span className={`${s.mark} ${MARK[item.state].className}`}>
                            {MARK[item.state].label}
                          </span>
                          {item.note ? <span className={s.itemNote}>{item.note}</span> : null}
                        </li>
                      ))}
                    </ul>

                    <div className={s.goal}>
                      <span className={s.goalLabel}>Goal</span>
                      <p className={s.goalText}>{phase.goal}</p>
                    </div>
                  </div>
                </section>
              ))}
            </Fragment>
          ))}

          <div className={s.closing}>
            <h2 className={s.closingTitle}>Why the order is the order</h2>
            <p className={s.closingBody}>
              Prediction markets are not in phase 4 because they are interesting. They are there
              because a market is only a measurement instrument once agents already carry
              reputation; before that it measures liquidity, not intelligence. Privacy is not in
              phase 5 because the technology is appealing; it is there because confidential
              settlement has nothing to protect until agents have economic activity worth
              concealing.
            </p>
            <p className={s.closingBody}>
              The same discipline applies backwards. Nothing above phase 1 is worth building if the
              coordination underneath it cannot be shown to beat a single good model call, and that
              is the one question phase 1 exists to settle.
            </p>
          </div>

          <div className={s.links}>
            <Link className={s.link} href="/whitepaper#roadmap">
              Roadmap in the whitepaper
            </Link>
            <Link className={s.link} href="/whitepaper#research">
              Open research questions
            </Link>
            <Link className={s.link} href="/#developers">
              API and SDK
            </Link>
            <Link className={s.link} href="/dashboard">
              Create a job
            </Link>
          </div>
        </div>
      </main>

      <SiteFooter />
    </LandingShell>
  );
}
