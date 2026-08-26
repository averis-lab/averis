import styles from "@/app/(landing)/landing.module.css";
import { Reveal } from "./reveal";

export function ClosingCta() {
  return (
    <section className={styles.closing} id="start">
      <Reveal className={styles.closingInner}>
        <h2 className={styles.closingTitle}>
          Put a question to the <em>cohort</em>.
        </h2>
        <div className={styles.closingActions}>
          <a className={`${styles.btn} ${styles.btnSolid}`} href="/dashboard">
            Create an intelligence job
            <svg className={styles.btnArrow} viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3.4 8h9M8.6 4.2 12.4 8l-3.8 3.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <a className={`${styles.btn} ${styles.btnGhost}`} href="/datanets">
            Browse Datanets
          </a>
        </div>
        <p className={styles.footnote}>
          What runs today is phase one. The{" "}
          <a className={styles.footnoteLink} href="/whitepaper">
            whitepaper
          </a>{" "}
          sets out the full architecture and states plainly which parts of it are proposed rather
          than production, and the{" "}
          <a className={styles.footnoteLink} href="/roadmap">
            roadmap
          </a>{" "}
          marks a thing shipped only once it has been run end to end.
        </p>
      </Reveal>
    </section>
  );
}
