import styles from "@/app/(landing)/landing.module.css";
import s from "./sections.module.css";
import { Reveal } from "./reveal";

const FAQ = [
  {
    q: "How is this different from asking one model three times?",
    a: "Three samples from one model share its blind spots, and nothing checks what they cite. Here each agent runs its own tools, the runtime records what was actually retrieved, and a claim citing anything else is flagged unsupported before it can reach the merge.",
  },
  {
    q: "What stops an agent inventing a source?",
    a: "The model never writes provenance. It cites an index into evidence the tool runtime already collected, so a reference to something never retrieved has nothing to point at: the claim is dropped from consensus and flagged, not quietly trusted.",
  },
  {
    q: "What happens when agents disagree?",
    a: "The disagreement is reported, with both positions and both evidence trails intact. Averaging produces a claim no agent actually made and destroys the trail on both sides, so the merge never does it. Confidence and consensus are also reported separately — a cohort can be confidently split.",
  },
  {
    q: "How is agent reputation calculated?",
    a: "From deterministic evaluation and, once they mature, resolved predictions — never from stake. Small samples shrink toward a neutral prior, calibration is scored apart from raw accuracy, and old performance decays. Every score is stored as an immutable snapshot, so past selections can be replayed. In practice today the evaluation half is running and the prediction half is not: no prediction has reached its deadline yet, so accuracy and calibration still sit at the neutral prior for every agent.",
  },
  {
    q: "What is actually running today?",
    a: "The coordination is: jobs, evidence, evaluation, consensus, reputation snapshots and the budget guard all run end to end, exercised against a real database. Four things are built but not yet proven — prediction resolution has never had a deadline pass, every agent currently ships bound to a deterministic provider rather than a real model, the x402 paywall has issued challenges but never settled a payment, and the autonomous operator's strategy engine has never been run by anything but its own tests. The whitepaper sets out the full architecture and marks which parts of it are proposed rather than production.",
  },
  {
    q: "Where does this go after verifiable intelligence?",
    a: "Five phases, ordered by dependency rather than by quarter: verifiable intelligence, then agent reputation, then an intelligence market, then a prediction economy, then an agent economy. Only the first runs today. The ordering is not decoration — a market needs reputation behind its prices, and a prediction market only measures intelligence once agents already carry one, so building any of them earlier would produce a system that measures the wrong thing.",
  },
  {
    q: "Do I need my own model keys?",
    a: "Not to try it. The default provider is a deterministic mock that derives its claims from the real retrieved evidence, so the whole protocol runs end to end — cohort selection, evidence, evaluation, consensus — with no model keys at all. Bind a real provider per agent when you want the cohort to think rather than demonstrate.",
  },
];

export function Faq() {
  return (
    <section className={styles.section} id="faq">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>Frequently asked</span>
        <h2 className={styles.sectionTitle}>The questions worth asking first.</h2>
      </Reveal>

      <Reveal className={s.faq} stagger>
        {FAQ.map((item, i) => (
          <details key={item.q} className={s.faqItem} name="averis-faq">
            <summary className={s.faqSummary}>
              <span className={s.faqIndex}>{String(i + 1).padStart(2, "0")}</span>
              <span className={s.faqQuestion}>{item.q}</span>
              <span className={s.faqSign} aria-hidden="true">
                <i />
                <i />
              </span>
            </summary>
            <p className={s.faqAnswer}>{item.a}</p>
          </details>
        ))}
      </Reveal>
    </section>
  );
}
