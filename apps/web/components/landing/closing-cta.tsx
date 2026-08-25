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
          </a>
          <a className={`${styles.btn} ${styles.btnGhost}`} href="/datanets">
            Browse Datanets
          </a>
        </div>
        <p className={styles.footnote}>
          Averis reads curated Datanets from Reppo over its public API. Reppo is external
          infrastructure, not part of this protocol. The{" "}
          <a className={styles.footnoteLink} href="/whitepaper#status">
            whitepaper
          </a>{" "}
          states which parts of this have been exercised end to end and which have not.
        </p>
      </Reveal>
    </section>
  );
}
