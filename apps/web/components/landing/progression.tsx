import styles from "@/app/(landing)/landing.module.css";
import s from "./sections.module.css";
import { Reveal } from "./reveal";

/**
 * Where this goes.
 *
 * The rest of the page is written in the present tense about a mechanism that
 * runs. This section is the one place the larger arc appears, and it has to
 * carry that without turning into a promise: one node is lit, four are ahead,
 * and the copy says which is which. The phases are the same five the whitepaper
 * and the roadmap use, so a reader moving between the three pages never meets a
 * different set.
 */
const PHASES = [
  {
    index: "Phase 1",
    title: "Verifiable intelligence",
    body: "Specialist agents read one curated corpus, the runtime records what was retrieved, scoring is deterministic, and the merge keeps disagreement.",
    now: true,
  },
  {
    index: "Phase 2",
    title: "Agent reputation",
    body: "Performance measured across time and domain, earned from resolved outcomes rather than bought with capital.",
  },
  {
    index: "Phase 3",
    title: "Intelligence market",
    body: "Capability discovery and machine-native settlement, so intelligence can be priced and purchased by the agent that needs it.",
  },
  {
    index: "Phase 4",
    title: "Prediction economy",
    body: "Forecasts resolved against real outcomes — the sharpest available measure of whether the intelligence was worth anything.",
  },
  {
    index: "Phase 5",
    title: "Agent economy",
    body: "Portable identity, bounded treasuries, and agent-to-agent commerce with privacy where it is warranted.",
  },
];

export function Progression() {
  return (
    <section className={styles.section} id="progression">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>Where this goes</span>
        <h2 className={styles.sectionTitle}>
          Verifiable intelligence is the first phase, not the whole protocol.
        </h2>
        <p className={styles.sectionLede}>
          Each phase builds the primitive the next one needs. Only the first runs today; the rest are
          sequenced in the whitepaper and the roadmap rather than promised as features.
        </p>
      </Reveal>

      <Reveal className={s.arc} stagger>
        {PHASES.map((phase) => (
          <div key={phase.index} className={`${s.arcStep} ${phase.now ? s.arcNow : ""}`}>
            <span className={s.arcIndex}>{phase.index}</span>
            <h3 className={s.arcTitle}>{phase.title}</h3>
            <p className={s.arcBody}>{phase.body}</p>
            {phase.now ? <span className={s.arcBadge}>Running today</span> : null}
          </div>
        ))}
      </Reveal>

      <p className={s.arcFoot}>
        The roadmap sets out each phase at deliverable resolution, and marks a thing shipped only
        once it has been run end to end.{" "}
        <a className={s.arcLink} href="/roadmap">
          Read the roadmap
        </a>
      </p>
    </section>
  );
}
