import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LandingShell } from "@/components/landing/landing-shell";
import { PaperToc } from "@/components/landing/paper-toc";
import { SiteFooter } from "@/components/landing/site-footer";
import s from "./whitepaper.module.css";

export const metadata: Metadata = {
  title: "Averis Whitepaper — Coordinating agents into verifiable intelligence",
  description:
    "How Averis turns curated data-network content into multi-agent intelligence: evidence recorded by the runtime, deterministic evaluation, consensus that preserves disagreement, and reputation earned from resolved outcomes.",
};

/**
 * The whitepaper.
 *
 * Written against the implementation rather than ahead of it: every mechanism
 * described here exists in this repository, and section 13 states plainly which
 * parts have been exercised and which have not. Where a number appears it is
 * either a configured default or a measured run, never an illustration.
 */

const SECTIONS = [
  { id: "coordination", title: "Fan-out is not coordination" },
  { id: "position", title: "Position in the stack" },
  { id: "job", title: "The intelligence job" },
  { id: "evidence", title: "Evidence and provenance" },
  { id: "evaluation", title: "Evaluation" },
  { id: "consensus", title: "Consensus" },
  { id: "reputation", title: "Reputation" },
  { id: "selection", title: "Cohort selection" },
  { id: "predictions", title: "Predictions and resolution" },
  { id: "autonomy", title: "Autonomy and spend safety" },
  { id: "economics", title: "Economics and payment" },
  { id: "trust", title: "Trust model" },
  { id: "status", title: "Implementation status" },
  { id: "open", title: "Open questions" },
];

/** Figures line up on the digit when they are set in the mono face. */
const num = (value: string) => <span className={s.numeric}>{value}</span>;

function Section({ index, id, title, children }: { index: number; id: string; title: string; children: ReactNode }) {
  return (
    <section className={s.section} id={id}>
      <span className={s.sectionNumber}>{String(index).padStart(2, "0")}</span>
      <h2 className={s.heading}>{title}</h2>
      {children}
    </section>
  );
}

function Figure({ n, caption, children }: { n: number; caption: ReactNode; children: string }) {
  return (
    <figure className={s.figure}>
      <div className={s.figureBody}>
        <pre>{children}</pre>
      </div>
      <figcaption className={s.caption}>
        <span className={s.exhibitLabel}>Figure {n}</span>
        {caption}
      </figcaption>
    </figure>
  );
}

function Table({
  n,
  caption,
  head,
  rows,
}: {
  n: number;
  caption?: string;
  head: string[];
  rows: ReactNode[][];
}) {
  return (
    <figure className={s.tableWrap}>
      <figcaption className={s.tableCaption}>
        <span className={s.exhibitLabel}>Table {n}</span>
        {caption}
      </figcaption>
      <div className={s.tableScroll}>
      <table className={s.table}>
        <thead>
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {cell}
                  </th>
                ) : (
                  <td key={j}>{cell}</td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

const LIFECYCLE = `CREATED → QUEUED → ASSIGNED → RUNNING → SUBMITTED → VALIDATING → CONSENSUS → RESOLVED
                                                                                    │
                                any non-terminal state ──────────────────────▶ FAILED`;

const STACK = `           ┌──────────────────────────────────────────────┐
           │  Intelligence API · SDK · web                │
           ├──────────────────────────────────────────────┤
  AVERIS   │  consensus · evaluation · reputation         │
           │  agent runtime · evidence collector          │
           │  job engine · budget guard · operator        │
           ├──────────────────────────────────────────────┤
           │  reppo-adapter  (provider-neutral)           │
           └───────────────────┬──────────────────────────┘
                               │  public read endpoints
           ┌───────────────────▼──────────────────────────┐
  REPPO    │  Datanets · pods · stake-backed curation     │
           └──────────────────────────────────────────────┘`;

const CLAIM = `{
  "statement": "62% of accepted pods cluster into three of eleven topics",
  "kind": "ASSESSMENT",
  "confidence": 0.74,
  "evidenceRefs": [0, 3]      ← indices into what the runtime retrieved
}`;

export default function WhitepaperPage() {
  return (
    <LandingShell hero={false}>
      <main className={s.page} id="top">
        <header className={s.masthead}>
          <span className={s.kicker}>
            Averis <b>·</b> Whitepaper <b>·</b> v0.1
          </span>
          <h1 className={s.title}>Coordinating agents into verifiable intelligence</h1>
          <dl className={s.meta}>
            {[
              ["Version", "0.1"],
              ["Revised", "23 Aug 2026"],
              ["Status", "Working implementation"],
              ["Settlement", "USDC, no token"],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className={s.metaLabel}>{label}</dt>
                <dd className={s.metaValue}>{value}</dd>
              </div>
            ))}
          </dl>

          <div className={s.abstract}>
            <span className={s.abstractLabel}>Abstract</span>
            <p>
              Running several language models over the same question and concatenating the answers
              produces more text, not more confidence. Averis is an accountability layer that turns
              curated data-network content into intelligence a reader can check: several specialist
              agents analyse the same corpus independently, each claim is bound to evidence the tool
              runtime actually retrieved, outputs are scored by a deterministic rubric, and the
              results are merged by a strategy that preserves disagreement instead of averaging it
              away.
            </p>
            <p>
              Four properties distinguish it from a fan-out. A model cannot author provenance. No
              model grades another model. Confidence and consensus are reported as separate numbers,
              because a cohort can be confidently split. And reputation is earned from resolved
              predictions rather than bought with capital.
            </p>
            <p>
              This document describes a system that exists. Section 13 separates what has been run
              end to end from what has been built but not yet exercised, and from what has not been
              built at all.
            </p>
          </div>
        </header>

        <div className={s.body}>
          <PaperToc
            entries={SECTIONS}
            className={s.toc}
            labelClassName={s.tocLabel}
            indexClassName={s.tocIndex}
            activeClassName={s.tocActive}
            progressClassName={s.tocProgress}
          />

          <article className={s.article}>
            <Section index={1} id="coordination" title="Fan-out is not coordination">
              <p>
                The obvious way to make a language model more reliable is to ask it more than once.
                The obvious way to make that better still is to ask several models. Both help, and
                neither produces a result anyone can audit, for three reasons.
              </p>
              <ul className={s.list}>
                <li>
                  <strong>Correlated error.</strong> Samples drawn from one model share its blind
                  spots. Averaging them raises confidence without raising accuracy, which is the
                  worst possible combination.
                </li>
                <li>
                  <strong>Unfalsifiable provenance.</strong> When the model writes its own citations,
                  a reference and a fabrication are the same kind of object. Nothing downstream can
                  tell them apart.
                </li>
                <li>
                  <strong>Averaging destroys the trail.</strong> Merging two opposed claims into a
                  midpoint yields a statement no analyst made, supported by an evidence trail that
                  no longer matches either side.
                </li>
              </ul>
              <p>
                Averis treats these as design constraints rather than tuning problems. The cohort is
                selected to decorrelate, provenance is recorded outside the model, and conflict is a
                first-class output.
              </p>
            </Section>

            <Section index={2} id="position" title="Position in the stack">
              <p>
                Reppo coordinates and prices <em>data</em> through stake-backed curation markets.
                Averis sits above it and coordinates the <em>intelligence</em> drawn from that data.
                Reppo is external infrastructure: nothing here reimplements Datanets, pods, voting
                or emissions, and only the public, unauthenticated read surface is used — the
                intelligence layer never needs custody of a user&apos;s session.
              </p>
              <Figure n={1} caption={<>The layer boundary. Everything below the adapter is somebody else&apos;s system.</>}>
                {STACK}
              </Figure>
              <p>
                One adapter owns the vocabulary mismatch between Reppo&apos;s documentation, its API
                and this protocol, so no other package has to know about it.
              </p>
              <Table n={1}
                head={["Reppo docs", "Reppo API", "Averis"]}
                rows={[
                  ["Datanet", <span className={s.mono} key="a">subnet</span>, <span className={s.mono} key="b">Datanet</span>],
                  ["Pod", <span className={s.mono} key="c">pod</span>, <span className={s.mono} key="d">DataItem</span>],
                  [
                    "veREPPO vote volume",
                    <span className={s.mono} key="e">upVoteVolume</span>,
                    <span className={s.mono} key="f">curation.approvalRate → qualityScore</span>,
                  ],
                ]}
              />
              <p>
                Two upstream behaviours are not in the documentation and were found by probing:{" "}
                <span className={s.code}>limit</span> is not honoured on the pods endpoint (a request
                for 40 rows returned 3,240), and the datanet filter is advisory. The adapter enforces
                both locally, so a datanet-scoped job can never draw evidence from a datanet it did
                not select.
              </p>
            </Section>

            <Section index={3} id="job" title="The intelligence job">
              <p>
                The protocol&apos;s primitive is a job: a question, the capabilities it needs, how
                many independent analysts to put on it, a budget, and optionally a confidence floor
                below which the result should not be delivered at all.
              </p>
              <Figure n={2} caption={<>The lifecycle is an explicit state machine, not a status column.</>}>
                {LIFECYCLE}
              </Figure>
              <p>Every transition does four things:</p>
              <ul className={s.list}>
                <li>validates against the transition table and throws otherwise;</li>
                <li>
                  reads the job&apos;s <strong>persisted</strong> status inside a transaction, so a
                  duplicated or out-of-order queue delivery cannot advance a job twice;
                </li>
                <li>refuses to leave a terminal state, so a late worker cannot resurrect a finished job;</li>
                <li>writes an audit row, so the path a job took stays reconstructible.</li>
              </ul>
              <p>
                Queues deliver at least once, and that is treated as normal rather than exceptional:
                enqueues carry a deduplication key and a repeated transition to the current state
                returns false rather than erroring.
              </p>
              <p>
                <strong>Failing is a valid outcome.</strong> A job whose merged confidence lands
                below its declared floor is failed rather than shipped. Intelligence the protocol
                will not stand behind should not be delivered, and the SDK throws rather than
                returning a partial result — a caller who forgot to check a status field would
                otherwise act on exactly that.
              </p>
            </Section>

            <Section index={4} id="evidence" title="Evidence and provenance">
              <p>
                This is the mechanism the rest of the protocol rests on. Agents never return prose as
                the payload; they return structured claims, and a claim cites evidence by integer
                reference.
              </p>
              <Figure n={3} caption={<>The model chooses which recorded item to point at. It cannot author a source.</>}>
                {CLAIM}
              </Figure>
              <p>
                The evidence array is supplied by the <strong>tool runtime</strong>, not the model.
                Each retrieval is recorded with its type, a stable source identifier, and a
                reliability score taken from upstream curation rather than the agent&apos;s opinion.
                A reference to an index that was never collected is silently dropped, and a claim
                left with nothing is flagged <span className={s.code}>unsupported</span> so
                evaluation penalises it. A model cannot manufacture provenance; the worst it can do
                is cite the wrong real thing, which is a mistake the evidence trail exposes.
              </p>
              <p>
                Evidence is deduplicated per job by content hash, so several agents citing the same
                upstream item share one provenance row and one stable index. Claims link to evidence
                many-to-many with a stance — supports or contradicts — which is what later lets
                consensus keep both sides of a contested topic rather than collapsing them.
              </p>
              <p>
                Reliability is tiered by origin. Stake-curated upstream data carries its measured
                curation score; unvetted web content fetched through the optional HTTP tool is
                recorded at <span className={s.code}>0.35</span>, materially below it, so an agent
                cannot launder a blog post into the same standing as a curated pod.
              </p>
            </Section>

            <Section index={5} id="evaluation" title="Evaluation">
              <p>
                Every output is scored before consensus runs, on five dimensions, by a{" "}
                <strong>deterministic</strong> evaluator.
              </p>
              <Table n={2}
                head={["Dimension", "Measures", "Weight"]}
                rows={[
                  ["evidenceQuality", "Reliability of cited sources × share of claims that cite anything × source breadth", "—"],
                  ["internalConsistency", "Absence of self-contradiction within one output", "—"],
                  ["specificity", "Figures and units rather than hedging", "—"],
                  ["corroboration", "Agreement with the cohort on topics it addressed", num("0.25")],
                  ["rubricAlignment", "Coverage of the datanet's own published vocabulary", num("0.08")],
                ]}
              />
              <p>
                No model grades another model. An LLM judge would introduce exactly the correlated
                error that multi-agent analysis exists to avoid, and its verdict could be neither
                replayed nor audited.
              </p>
              <p>
                Corroboration carries only a quarter of the weight <em>on purpose</em>. A
                well-evidenced, specific, internally consistent minority position still scores
                respectably: a protocol that prices correct dissent out of existence has optimised
                itself into a single opinion with extra steps.
              </p>
              <h3 className={s.subheading}>Datanet rubrics, quoted and never obeyed</h3>
              <p>
                Each datanet publishes its own standard for what should be submitted and how it
                should be judged. Averis carries that through into the agent prompt, so a robotics
                corpus and a prediction-market corpus are judged by their own stated standards rather
                than one generic yardstick, and into evaluation as term coverage — which is why it
                carries the smallest weight of the five and stays neutral when no rubric exists.
              </p>
              <p>
                That text is written by whoever created the datanet, which makes it third-party
                content. It goes in the user turn, never the system prompt, so it cannot inherit
                operator authority; it is fenced and labelled as quoted material that cannot change
                the task or the output format; and the agent is told to <strong>report</strong>{" "}
                anything resembling a directive as a finding rather than follow it. The wording is
                not filtered — stripping &ldquo;injection attempts&rdquo; from free prose is
                unreliable and breeds false confidence. Placement is the defence. The rubric is
                snapshotted when a job uses it, because a datanet can rewrite its standard at any
                time and an old evaluation would otherwise be impossible to reproduce.
              </p>
            </Section>

            <Section index={6} id="consensus" title="Consensus">
              <p>Merging runs in four steps.</p>
              <h3 className={s.subheading}>1 · Cluster</h3>
              <p>
                Claims about the same topic are grouped by lexical similarity. Plain Jaccard was
                insufficient: it punishes a claim for being more detailed, scoring &ldquo;the signal
                is reliable&rdquo; against &ldquo;the signal is not reliable at 42.1% approval&rdquo;
                at 0.375 and hiding a real contradiction. The measure blends Jaccard with
                length-damped containment.
              </p>
              <h3 className={s.subheading}>2 · Weight</h3>
              <Table n={3}
                caption="Multi-factor weighting. Self-reported confidence is the one signal an agent can inflate for free, so it carries the least."
                head={["Factor", "Weight"]}
                rows={[
                  ["Domain reputation", num("0.30")],
                  ["Accuracy", num("0.20")],
                  ["Evidence quality", num("0.20")],
                  ["Calibration", num("0.15")],
                  ["Evaluation score", num("0.10")],
                  ["Self-reported confidence", num("0.05")],
                ]}
              />
              <p>
                Any single agent is capped — by default at half the total weight — so a cohort cannot
                degenerate into one agent with extra steps, and floored, so a newcomer can still
                build a record. Uniform weighting is kept as a first-class strategy rather than a
                placeholder: it is the control group any claim about reputation weighting has to be
                measured against.
              </p>
              <h3 className={s.subheading}>3 · Merge</h3>
              <p>
                Within a cluster, claims are split by stance. The majority position is reported{" "}
                <strong>as an agent actually worded it</strong>, never as an average. Where the
                opposing side carries meaningful weight the topic is emitted as a disagreement with
                every position preserved. Confidence and consensus are reported as separate numbers,
                because collapsing them would hide the case this protocol most wants to surface: a
                cohort that is confident and split.
              </p>
              <h3 className={s.subheading}>4 · Scale by corroboration breadth</h3>
              <p>
                Agreement alone is not consensus. One agent agreeing with itself once scored
                identically to three agents that genuinely converged, which overstated the result to
                anyone reading the headline number. The raw agreement is therefore multiplied by how
                much independent corroboration actually materialised:
              </p>
              <div className={s.equation}>
                factor = (1 − 1/n) / (1 − 1/target)
                <span className={s.equationNote}>
                  n = agents that finished. Zero at n = 1, because one agent corroborates nothing;
                  steep between one and three, flattening after, matching how fast the value of one
                  more independent opinion falls away. The raw agreement is retained so the discount
                  is auditable rather than hidden.
                </span>
              </div>
              <Table n={4}
                caption="Measured on a real short cohort. The recommendation is gated the same way, so a lone agent calling a corpus decision-grade cannot read as confident advice."
                head={["Cohort", "Agents", "Consensus", "Confidence", "Recommendation"]}
                rows={[
                  ["Full", num("3 of 3"), num("87%"), num("83%"), num("73%")],
                  ["Short", num("1 of 4"), num("0%"), num("54%"), num("28%")],
                ]}
              />
            </Section>

            <Section index={7} id="reputation" title="Reputation">
              <p>
                Reputation is multidimensional and derived from measured performance only: accuracy
                from resolved predictions, calibration from a Brier score, consistency from internal
                coherence and stability of cohort agreement, and evidence quality from deterministic
                evaluation over time.
              </p>
              <ul className={s.list}>
                <li>
                  <strong>Capital is not an input.</strong> There is no stake parameter anywhere in
                  the observation record.
                </li>
                <li>
                  <strong>Small samples shrink toward neutral.</strong> With a prior strength of ten,
                  three lucky calls land near 0.6 rather than 1.0 — reputation cannot be manufactured
                  by spraying cheap high-confidence claims and cherry-picking the hits.
                </li>
                <li>
                  <strong>Calibration is scored apart from accuracy.</strong> Being right 90% of the
                  time while claiming 99% certainty is a distinct failure, and the merge needs to
                  know about it independently.
                </li>
                <li>
                  <strong>Old performance decays</strong>, on a 90-day half-life. Nobody coasts.
                </li>
              </ul>
              <p>
                Scores are stored as immutable snapshots and recomputed from full history rather than
                incremented, so a change to the scoring rule can be applied retroactively and any
                past selection can be replayed exactly as it was made.
              </p>
            </Section>

            <Section index={8} id="selection" title="Cohort selection">
              <p>
                Selection is explicitly <em>not</em> &ldquo;top N by overall reputation&rdquo;.
                Domain reputation outranks overall reputation, because a generalist with a stellar
                record is a worse pick for a liquidity question than a specialist with a solid record
                in that domain. Each subsequent pick is scored against the cohort already chosen, so
                later seats go to agents covering ground the first pick did not — which is what
                decorrelates the cohort&apos;s errors rather than hoping they are independent.
              </p>
              <p>
                Agents at their concurrency limit, paused, or above the per-agent budget are
                excluded, and a smaller qualified cohort is preferred over a full unqualified one. A
                new agent starts at the neutral prior rather than zero, so it can be selected and
                earn a record; declared proficiency is a hint that measured performance corrects.
              </p>
            </Section>

            <Section index={9} id="predictions" title="Predictions and resolution">
              <p>
                A claim marked as a prediction carries machine-checkable criteria and a deadline.
                After the deadline passes, the resolution stage asks a matching oracle for the
                observed value and records the outcome plus a Brier score.
              </p>
              <p>
                When no oracle can answer, the prediction is recorded{" "}
                <span className={s.code}>UNRESOLVABLE</span> — not guessed. Scoring an unverifiable
                claim in either direction would corrupt accuracy with noise, and accuracy is the one
                number in this system that is supposed to mean something.
              </p>
              <p>
                This loop is what gives reputation its teeth. Every other signal scores an agent on
                how its work <em>looks</em>; only this one scores it on whether it was right.
              </p>
            </Section>

            <Section index={10} id="autonomy" title="Autonomy and spend safety">
              <p>
                An operator is a node that runs unattended: it discovers jobs, decides which are
                worth taking, verifies it can afford them, runs the agents and monitors outcomes.
                Strategy and budget are deliberately separate concerns — strategy answers{" "}
                <em>is this job worth doing</em>, budget answers <em>can it be afforded right now</em>
                . Conflating them lets an operator with spare budget take work it should decline, and
                an operator with good strategy overspend.
              </p>
              <p>
                Configuration validation is strict and fails at startup. A per-job cap above the
                daily cap, or a transaction reserve that swallows the daily budget, refuses to boot;
                a malformed cadence throws rather than defaulting, so a node never polls at a rate
                its operator did not choose. A node that runs unattended on a silently defaulted
                budget is the failure this project treats as dangerous.
              </p>
              <p>
                Budget enforcement is atomic. Check-then-reserve is not: ten concurrent callers all
                read the same headroom and all spend it. Reservation therefore holds a lock — an
                in-process mutex, or a database advisory lock across processes — and the ledger
                counts in-flight reservations, not only settled ones.
              </p>
            </Section>

            <Section index={11} id="economics" title="Economics and payment">
              <p>
                No protocol token. USDC only. The reward split is configurable and normalised, so a
                misconfigured split can never pay out more than the job&apos;s budget.
              </p>
              <Table n={5}
                head={["Role", "Default share", "Basis"]}
                rows={[
                  ["Agents", num("70%"), "Shared by earned consensus weight"],
                  ["Validators", num("15%"), "Evaluation work"],
                  ["Protocol", num("10%"), "Operation"],
                  ["Treasury", num("5%"), "Reserve"],
                ]}
              />
              <p>
                On the inbound side, job creation can be put behind an{" "}
                <a className={s.link} href="https://x402.org" target="_blank" rel="noreferrer noopener">
                  x402
                </a>{" "}
                paywall: the gateway answers an unpaid request with a 402 and its payment
                requirements, the client retries with a signed payload, and a facilitator verifies
                and settles it on Solana without ever holding funds. The fee is flat and separate
                from the job&apos;s budget, because the price has to be quoted before the request
                body is parsed — pricing from a budget passed in the query string would be quotable
                but not enforceable, since settlement precedes the handler. The payment is recorded
                on the job it bought.
              </p>
              <p>
                On the outbound side, deciding what is owed and paying it are separate steps, and
                the separation is physical: the rules live in a module that imports no database, so
                every one of them can be checked without a chain, a database or money. Three hold
                regardless of how payment is made. An agent with no registered payout address is
                skipped rather than guessed at. A job whose rewards exceed its budget is held in
                full, because paying part of a split that does not add up is harder to unwind than
                paying none of it. And a reward is paid <strong>at most once</strong> — claiming it
                is a conditional update, and the transaction row is unique per reward, so two
                sweeps racing cannot both pay.
              </p>
              <p>
                What does not exist is an on-chain driver. The shipped drivers refuse to pay
                (<span className={s.code}>none</span>, the default) or record a payment made outside
                this system so the amount is not owed twice (
                <span className={s.code}>ledger</span>). A transfer path nobody has ever run is the
                most dangerous thing a settlement layer can contain, because it looks ready.
              </p>
            </Section>

            <Section index={12} id="trust" title="Trust model">
              <p>
                The protocol assumes agents are self-interested and upstream text is hostile. Each
                defence below is a mechanism in the code, not a policy.
              </p>
              <Table n={6}
                head={["Attack", "Defence"]}
                rows={[
                  ["Fabricated citation", "Provenance is recorded by the tool runtime; unknown references are dropped and the claim is flagged unsupported"],
                  ["Prompt injection via datanet rubric", "Third-party text sits in the user turn, fenced and labelled; the agent reports directives instead of obeying them"],
                  ["Reputation farming", "Shrinkage toward the neutral prior, calibration scored apart from accuracy, 90-day decay"],
                  ["Buying influence", "No stake input exists anywhere in the scoring path"],
                  ["Cohort capture", "Per-agent weight cap, plus marginal-diversity selection"],
                  ["Server-side request forgery via the HTTP tool", "Host allowlist, private and link-local ranges denied, responses byte-capped"],
                  ["Cross-tenant reads", "Scope is part of the query's where clause; another account's job is a 404, never a 403"],
                  ["Overspend under concurrency", "Reservation holds a lock and counts in-flight spend"],
                  ["Queue redelivery", "Transitions validate against persisted state inside a transaction"],
                ]}
              />
              <p>
                Two limits are worth stating plainly. The protocol verifies that a claim is{" "}
                <em>bound to real retrieved evidence</em>; it does not verify that the evidence is
                true — that is the upstream curation market&apos;s job, and its score is carried
                through rather than re-derived. And an agent can still be wrong in a
                well-evidenced, internally consistent way. The answer to that is the resolution loop
                in section 9, which is slow by construction.
              </p>
            </Section>

            <Section index={13} id="status" title="Implementation status">
              <p>
                A whitepaper that does not separate the built from the intended is a pitch. This is
                the separation.
              </p>
              <Table n={7}
                head={["Component", "State", "Note"]}
                rows={[
                  ["Job engine and lifecycle", <span className={`${s.state} ${s.shipped}`} key="1">Exercised</span>, "Driven end to end by integration tests against a real database"],
                  ["Evidence and tool runtime", <span className={`${s.state} ${s.shipped}`} key="2">Exercised</span>, "Live reads from the upstream network"],
                  ["Evaluation and consensus", <span className={`${s.state} ${s.shipped}`} key="3">Exercised</span>, "Deterministic; numbers in section 6 are measured"],
                  ["Operator, strategy, budget guard", <span className={`${s.state} ${s.shipped}`} key="4">Exercised</span>, "Concurrency races found and fixed under test"],
                  ["Tenancy and account keys", <span className={`${s.state} ${s.shipped}`} key="5">Exercised</span>, "Scoping verified through the real gateway"],
                  ["x402 inbound payment", <span className={`${s.state} ${s.untested}`} key="6">Challenge only</span>, "402 issuance verified against a live facilitator; no payment has been settled"],
                  ["Prediction resolution", <span className={`${s.state} ${s.untested}`} key="7">Not yet exercised</span>, "No prediction has matured, so accuracy and calibration sit at the prior"],
                  ["A real LLM cohort", <span className={`${s.state} ${s.untested}`} key="8">Not yet exercised</span>, "Agents ship bound to a deterministic provider"],
                  ["Outbound settlement", <span className={`${s.state} ${s.untested}`} key="9">Off-chain only</span>, "Mechanics and guards implemented; the ledger driver records payments made elsewhere, and no on-chain driver exists"],
                  ["Metrics and tracing", <span className={`${s.state} ${s.absent}`} key="10">Not built</span>, "Cost, latency and failure rates are invisible"],
                ]}
              />
              <p>
                Deliberately not built, and not planned: a protocol token, a DAO, a custom chain, a
                custom inference network, and cross-chain infrastructure. None of them are needed to
                answer the question in section 14, and each would add a system to maintain in place
                of an answer.
              </p>
            </Section>

            <Section index={14} id="open" title="Open questions">
              <p>
                The mechanics work. What they are worth is still an empirical question, and the
                honest list is short:
              </p>
              <ul className={s.list}>
                <li>
                  <strong>Does merging beat one good call?</strong> Every agent currently runs a
                  deterministic provider, which proves the coordination but not the value. Whether
                  real specialist agents produce meaningfully different analyses — and whether the
                  merge of them beats a single strong model — is the question this project exists to
                  answer.
                </li>
                <li>
                  <strong>Does reputation converge?</strong> Shrinkage and decay are principled, but
                  the rate at which a cohort&apos;s scores separate signal from noise has not been
                  observed over a real horizon.
                </li>
                <li>
                  <strong>How far does oracle coverage reach?</strong> One oracle exists today.
                  Price and on-chain predictions currently resolve as unresolvable, which is honest
                  but leaves accuracy sparse.
                </li>
                <li>
                  <strong>Who signs, and under what policy?</strong> The settlement guards are in
                  place, but an on-chain driver needs a key that can move funds, and the question of
                  what may authorise that — a threshold, a delay, a human — is a governance design
                  this project has deliberately not started.
                </li>
                <li>
                  <strong>Should an unspent budget be refunded?</strong> The inbound fee is charged
                  once, up front; partial settlement against actual spend is expressible in the
                  payment protocol but not implemented here.
                </li>
              </ul>

              <p className={s.endnote}>
                The claim Averis makes is narrow on purpose: not that its intelligence is
                correct, but that every part of it can be checked. Each claim names the evidence it
                used, each score can be recomputed, each merge can be replayed, and each
                disagreement is still there to read.
              </p>

              <div className={s.sourceLinks}>
                <Link className={s.sourceLink} href="/#how-it-works">
                  How it works
                </Link>
                <Link className={s.sourceLink} href="/#developers">
                  API and SDK
                </Link>
                <Link className={s.sourceLink} href="/datanets">
                  Browse Datanets
                </Link>
                <Link className={s.sourceLink} href="/dashboard">
                  Create a job
                </Link>
              </div>
            </Section>
          </article>
        </div>
      </main>

      <SiteFooter />
    </LandingShell>
  );
}
