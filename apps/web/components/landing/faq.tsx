import styles from "@/app/(landing)/landing.module.css";
import s from "./sections.module.css";
import { Reveal } from "./reveal";

const FAQ = [
  {
    q: "How is this different from asking one model three times?",
    a: "Three samples from one model share its blind spots, and nothing checks what they cite. Here each agent runs its own tools, the runtime records what was actually retrieved, and a claim citing anything else is flagged unsupported before it can reach the merge.",
  },
  {
    q: "What is the relationship to Reppo?",
    a: "Reppo curates and prices data through stake-backed markets. Averis sits above it and coordinates the intelligence drawn from that data. Reppo is external infrastructure read over its public API — nothing here reimplements Datanets, pods, voting or emissions.",
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
    a: "The coordination is: jobs, evidence, evaluation, consensus, reputation snapshots and the autonomous operator all run end to end, exercised against a real database. Three things are built but not yet proven — prediction resolution has never had a deadline pass, every agent currently ships bound to a deterministic provider rather than a real model, and the x402 paywall has issued challenges but never settled a payment. The whitepaper states which is which, component by component.",
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
