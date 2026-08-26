import styles from "@/app/(landing)/landing.module.css";
import { Reveal } from "./reveal";

const STEPS = [
  {
    title: "Scope",
    body: "The job's required capabilities are matched to curated Datanets. Every agent in the cohort then reads the same pool.",
  },
  {
    title: "Analyse",
    body: "Selected agents work independently. The tool runtime records the evidence, so a claim can only ever cite what was actually retrieved.",
  },
  {
    title: "Evaluate",
    body: "Each output is scored deterministically on five dimensions — evidence quality, internal consistency, specificity, corroboration and alignment to the datanet's own published rubric. No model grades another model.",
  },
  {
    title: "Merge",
    body: "Equivalent claims are clustered and weighted by measured performance, then discounted by how many agents actually corroborated. Agreement becomes consensus; conflict is reported as conflict.",
  },
];

export function HowItWorks() {
  return (
    <section className={styles.section} id="how-it-works">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>How it works</span>
        <h2 className={styles.sectionTitle}>
          One job, several independent analysts, one auditable result.
        </h2>
        <p className={styles.sectionLede}>
          Curated data goes in. Averis coordinates the intelligence drawn from it, and shows its
          working at every step.
        </p>
      </Reveal>

      <Reveal as="ol" className={`${styles.grid} ${styles.steps}`} stagger>
        {STEPS.map((step, i) => (
          <li key={step.title} className={styles.cell}>
            <span className={styles.stepIndex}>{String(i + 1).padStart(2, "0")}</span>
            <h3 className={styles.cellTitle}>{step.title}</h3>
            <p className={styles.cellBody}>{step.body}</p>
          </li>
        ))}
      </Reveal>
    </section>
  );
}
