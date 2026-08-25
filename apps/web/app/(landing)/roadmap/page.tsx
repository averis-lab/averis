import type { Metadata } from "next";
import Link from "next/link";
import { LandingShell } from "@/components/landing/landing-shell";
import { SiteFooter } from "@/components/landing/site-footer";
import s from "./roadmap.module.css";

export const metadata: Metadata = {
  title: "Averis Roadmap — From a working mechanism to a checkable one",
  description:
    "What is built, what is being proven, and what comes next: the phases that take Averis from a working mechanism to a checkable one.",
};

/**
 * The roadmap.
 *
 * Written to the same rule as the whitepaper: a deliverable is `shipped` only
 * when it has been run end to end, not when the code exists. Three items in
 * phase 0 are built and unproven, and they are listed under phase 1 as the work
 * of proving them rather than counted as done twice.
 */

type State = "shipped" | "active" | "planned";

interface Item {
  text: string;
  state: State;
  note?: string;
}

interface Phase {
  id: string;
  index: string;
  when: string;
  status: State;
  statusLabel: string;
  title: string;
  body: React.ReactNode;
  items: Item[];
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

const PHASES: Phase[] = [
  {
    id: "phase-0",
    index: "Phase 0",
    when: "Q2 – Q3 2026",
    status: "shipped",
    statusLabel: "Complete",
    title: "Prove the coordination mechanism",
    body: (
      <>
        Everything needed to run a job end to end and stand behind the result: a lifecycle that
        survives at-least-once delivery, provenance the model cannot author, scoring no model
        performs, and a merge that keeps disagreement instead of averaging it. Exercised against a
        real database and live upstream data, not sketched.
      </>
    ),
    items: [
      { text: "Job engine and explicit lifecycle state machine", state: "shipped" },
      {
        text: "Evidence recorded by the tool runtime, cited by index",
        state: "shipped",
        note: "A reference to something never retrieved is dropped and the claim flagged unsupported.",
      },
      { text: "Deterministic evaluation across five dimensions", state: "shipped" },
      {
        text: "Consensus that preserves disagreement, scaled by corroboration breadth",
        state: "shipped",
      },
      { text: "Reputation as immutable, replayable snapshots", state: "shipped" },
      {
        text: "Autonomous operator, with budget reserved atomically before execution",
        state: "shipped",
      },
      { text: "Tenancy: per-account keys, reads scoped in the query", state: "shipped" },
      { text: "Typed SDK, in-app API playground, x402 paywall", state: "shipped" },
      {
        text: "The explanation chain: verdict, claims, and the curation behind each source",
        state: "shipped",
        note: "Evidence and reasoning reliability are reported separately; outcome reliability stays null until predictions resolve.",
      },
      {
        text: "Settlement mechanics — a reward is payable at most once",
        state: "shipped",
        note: "Proven by two sweeps racing against a real database. The ledger driver records payments made elsewhere; no on-chain driver exists.",
      },
    ],
  },
  {
    id: "phase-1",
    index: "Phase 1",
    when: "Q3 – Q4 2026",
    status: "active",
    statusLabel: "In progress",
    title: "Make the claim checkable",
    body: (
      <>
        The mechanics work. What they are <em>worth</em> is still unmeasured, and this phase exists
        to settle that. Nothing here is a new subsystem — it is the work of turning three built but
        unexercised things into evidence, and of making the protocol runnable by someone who did not
        write it.
      </>
    ),
    items: [
      {
        text: "Run the prediction → resolution loop for real",
        state: "active",
        note: "No prediction has reached a deadline yet, so accuracy and calibration still sit at the neutral prior for every agent. Short-horizon predictions and a matching oracle are what start the clock.",
      },
      {
        text: "Agent track record: measured accuracy and Brier score",
        state: "planned",
        note: "Depends on the loop above. Until it runs, reputation is scored on how work looks, never on whether it was right.",
      },
      {
        text: "Cohort benchmark — one model against three, five, and a single strong call",
        state: "planned",
        note: "Accuracy claims need ground truth, so this follows resolution. Before then it can honestly report cost, latency, consistency and evidence coverage — not accuracy.",
      },
      {
        text: "A cohort bound to real models rather than the deterministic provider",
        state: "planned",
      },
      {
        text: "Prisma migrations, replacing db push",
        state: "planned",
        note: "No safe deploy and no rollback without them; a release command that finds no migrations exits successfully having applied nothing.",
      },
      { text: "Metrics and tracing — cost, latency and failure rates", state: "planned" },
      {
        text: "Authenticated reads for permissioned Datanets",
        state: "planned",
        note: "The adapter reads only the public surface today, which is the whole enterprise tier it cannot reach.",
      },
    ],
  },
  {
    id: "phase-2",
    index: "Phase 2",
    when: "Q4 2026 – Q1 2027",
    status: "planned",
    statusLabel: "Planned",
    title: "Attach to the decision someone is already paying for",
    body: (
      <>
        Curated data being sold and staked on creates a question nobody currently owns:{" "}
        <strong>which corpus is worth paying for?</strong> That is a buy-side judgement, it is the
        query this protocol was demonstrated on from the first day, and it is where Averis stops
        being infrastructure looking for a use.
      </>
    ),
    items: [
      { text: "Datanet diligence as a product surface, not a job type", state: "planned" },
      { text: "Comparison across several corpora in one report", state: "planned" },
      {
        text: "Scheduled re-assessment on the curation cycle",
        state: "planned",
        note: "Upstream quality is re-priced every 48 hours; a diligence read older than that is describing a corpus that has moved.",
      },
      {
        text: "Payment priced by cohort size rather than a flat fee",
        state: "planned",
        note: "A one-agent job currently costs the same as a five-agent one.",
      },
      { text: "An on-chain settlement driver, so agents are actually paid", state: "planned" },
      { text: "Per-reader identity in the browser", state: "planned" },
    ],
  },
  {
    id: "phase-3",
    index: "Phase 3",
    when: "2027 and beyond",
    status: "planned",
    statusLabel: "Planned",
    title: "Close the loop",
    body: (
      <>
        Averis consumes accountable evidence and produces deterministic evaluations and resolved
        predictions — which is itself evaluation signal, and exactly what buyers of curated data are
        looking for. Publishing it back turns a one-way read into a two-way relationship.
      </>
    ),
    items: [
      { text: "Averis output published back as a curated datanet", state: "planned" },
      {
        text: "More oracles: price and on-chain resolution",
        state: "planned",
        note: "One oracle exists today, so price and on-chain predictions resolve as UNRESOLVABLE — honest, but it leaves accuracy sparse.",
      },
      { text: "Open agent registry, selected on measured reputation", state: "planned" },
      { text: "Payers on chains beyond Solana", state: "planned" },
    ],
  },
];

export default function RoadmapPage() {
  return (
    <LandingShell hero={false}>
      <main className={s.page} id="top">
        <header className={s.masthead}>
          <span className={s.kicker}>
            Averis <b>·</b> Roadmap
          </span>
          <h1 className={s.title}>From a working mechanism to a checkable one</h1>

          <p className={s.lede}>
            One rule governs this page: a deliverable is marked <strong>shipped</strong> only when it
            has been run end to end, never when the code merely exists. Three things built in phase 0
            are not counted as done — they appear in phase 1 as the work of proving them.
          </p>
          <p className={s.lede}>
            The phases track the market Averis reads from. As curated data starts being bought and
            staked on, the question of which corpus deserves that money becomes real, and answering
            it with something auditable is the whole point of this protocol.
          </p>

          <dl className={s.meta}>
            {[
              ["Revised", "25 Aug 2026"],
              ["Now", "Phase 1"],
              ["Not planned", "Token, DAO, marketplace"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className={s.metaLabel}>{label}</dt>
                <dd className={s.metaValue}>{value}</dd>
              </div>
            ))}
          </dl>
        </header>

        <div className={s.body}>
          {PHASES.map((phase) => (
            <section key={phase.id} className={s.phase} id={phase.id}>
              <aside className={s.phaseAside}>
                <span className={s.phaseIndex}>{phase.index}</span>
                <span className={s.phaseWhen}>{phase.when}</span>
                <span className={`${s.status} ${STATUS[phase.status]}`}>{phase.statusLabel}</span>
              </aside>

              <div>
                <h2 className={s.phaseTitle}>{phase.title}</h2>
                <p className={s.phaseBody}>{phase.body}</p>

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
              </div>
            </section>
          ))}

          <div className={s.closing}>
            <h2 className={s.closingTitle}>What is deliberately absent</h2>
            <p className={s.closingBody}>
              No protocol token, no DAO, no custom chain, no custom inference network, no
              marketplace. Each would add a system to maintain in place of an answer, and the
              question phase 1 exists to settle — whether merging several agents beats one good call
              — is not made easier by any of them.
            </p>
            <p className={s.closingBody}>
              Settlement is in USDC. Reputation takes no stake as an input: capital holds a data
              judgement accountable, and measured outcomes hold an analytical one accountable. They
              are different objects with different failure modes.
            </p>
          </div>

          <div className={s.links}>
            <Link className={s.link} href="/whitepaper#status">
              Component-level status
            </Link>
            <Link className={s.link} href="/whitepaper#open">
              Open questions
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
