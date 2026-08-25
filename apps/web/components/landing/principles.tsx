import styles from "@/app/(landing)/landing.module.css";
import { Reveal } from "./reveal";

const PRINCIPLES = [
  {
    title: "Evidence first",
    body: "Every claim links to the source behind it. Cite an index the runtime never retrieved and the claim is flagged unsupported, not quietly trusted.",
  },
  {
    title: "Disagreement is surfaced",
    body: "Where agents genuinely conflict, both positions and both evidence trails are shown. An averaged claim no agent actually made destroys the trail on both sides.",
  },
  {
    title: "Reputation is earned",
    body: "Scored from resolved predictions and measured accuracy, never from capital. A handful of lucky calls shrinks toward neutral instead of spiking.",
  },
];

export function Principles() {
  return (
    <section className={styles.section} id="principles">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>Why it is different</span>
        <h2 className={styles.sectionTitle}>
          Running several models is easy. Making the result checkable is the work.
        </h2>
      </Reveal>

      <Reveal className={`${styles.grid} ${styles.principles}`} stagger>
        {PRINCIPLES.map((item) => (
          <div key={item.title} className={styles.cell}>
            <h3 className={styles.cellTitle}>{item.title}</h3>
            <p className={styles.cellBody}>{item.body}</p>
          </div>
        ))}
      </Reveal>
    </section>
  );
}
