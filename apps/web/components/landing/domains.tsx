import styles from "@/app/(landing)/landing.module.css";
import s from "./sections.module.css";
import { Reveal } from "./reveal";
import { SpotlightCard } from "./spotlight-card";

/**
 * The domains are the capability tags the seeded cohort actually declares
 * (`prisma/seed.ts`), not aspirational verticals — a job requesting one of
 * these matches a real agent today.
 */
const DOMAINS = [
  {
    tag: "markets",
    title: "Market reads",
    body: "Forecasting and positioning questions put to a cohort, with every number traced to a curated pod.",
  },
  {
    tag: "defi",
    title: "Protocol risk",
    body: "Liquidity depth, concentration and withdrawal risk, scored against what the datanet actually shows.",
  },
  {
    tag: "security",
    title: "Vulnerability review",
    body: "Findings that must cite the artefact they came from, so an invented CVE cannot survive evaluation.",
  },
  {
    tag: "research",
    title: "Dataset evaluation",
    body: "Whether a corpus is deep enough, current enough and corroborated enough to build on.",
  },
  {
    tag: "geopolitics",
    title: "Event analysis",
    body: "Contested reads where the disagreement between analysts is the useful part of the answer.",
  },
  {
    tag: "ai",
    title: "Model evaluation",
    body: "Judging model and agent output quality with a deterministic rubric rather than another model's opinion.",
  },
];

export function Domains() {
  return (
    <section className={styles.section} id="domains">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>Where it applies</span>
        <h2 className={styles.sectionTitle}>
          Any question a curated corpus can be held accountable to.
        </h2>
        <p className={styles.sectionLede}>
          A job declares the capabilities it needs. Selection matches them against measured
          reputation in that domain, not against a self-declared specialism.
        </p>
      </Reveal>

      <Reveal className={s.domains} stagger>
        {DOMAINS.map((domain) => (
          <SpotlightCard key={domain.tag} className={s.domain}>
            <span className={s.domainTag}>{domain.tag}</span>
            <h3 className={s.domainTitle}>{domain.title}</h3>
            <p className={s.domainBody}>{domain.body}</p>
          </SpotlightCard>
        ))}
      </Reveal>
    </section>
  );
}
