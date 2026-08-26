import styles from "@/app/(landing)/landing.module.css";
import panel from "./sections.module.css";
import { Reveal } from "./reveal";

/**
 * An illustrative report, not a live one.
 *
 * The landing page deliberately touches no database, so these numbers are
 * fixed. They are the shape a real `/v1/jobs/:id/intelligence` response takes —
 * weights that sum to one, evidence that every claim actually cites, and a
 * disagreement left standing rather than averaged away — and the caption says
 * plainly that it is an example.
 *
 * Evidence locators are shown without their scheme. That is a truncation of the
 * identifier the API returns, not a different one: the chip is 10.5px wide
 * enough for the path, and the path is the part that identifies the source.
 */

const CLAIMS = [
  {
    kind: "ASSESSMENT",
    confidence: 0.74,
    statement:
      "Curation depth is uneven: 62% of accepted pods cluster into three of the eleven declared topics.",
    evidence: [
      { source: "datanet/geo-intel", reliability: 0.86 },
      { source: "pod/8c41f2", reliability: 0.79 },
    ],
  },
  {
    kind: "FACT",
    confidence: 0.91,
    statement: "Median stake-weighted vote margin across the sampled pods is 0.34.",
    evidence: [{ source: "compute:evidence-stats", reliability: 1 }],
  },
  {
    kind: "PREDICTION",
    confidence: 0.58,
    statement:
      "Cross-pod corroboration stays above 0.60 through the next curation epoch.",
    evidence: [
      { source: "pod/2b90ac", reliability: 0.74 },
      { source: "pod/f17d33", reliability: 0.68 },
    ],
  },
  {
    kind: "RISK",
    confidence: 0.66,
    statement:
      "Two topics rest on a single contributor, so one withdrawal removes the corroboration behind them.",
    evidence: [{ source: "datanet/geo-intel", reliability: 0.86 }],
  },
];

const CONTRIBUTIONS = [
  { agent: "Markets Agent", weight: 0.38, agreement: 0.71 },
  { agent: "Data Quality Agent", weight: 0.33, agreement: 0.44 },
  { agent: "Research Agent", weight: 0.29, agreement: 0.68 },
];

const pct = (value: number) => `${Math.round(value * 100)}%`;

export function ReportPreview() {
  return (
    <section className={styles.section} id="preview">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>What comes back</span>
        <h2 className={styles.sectionTitle}>
          A report that shows its working, claim by claim.
        </h2>
        <p className={styles.sectionLede}>
          Confidence and consensus are reported separately, every claim carries the evidence it
          cites, and the one thing the cohort could not agree on is left standing.
        </p>
      </Reveal>

      <Reveal className={panel.panel} delay={0.06}>
        <header className={panel.chrome}>
          <span className={panel.dots} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className={panel.crumb}>
            averis.ai<span className={panel.slash}>/</span>jobs
            <span className={panel.slash}>/</span>
            <strong>job_7f2ad91c</strong>
          </span>
          <span className={panel.status}>RESOLVED</span>
        </header>

        <div className={panel.body}>
          <p className={panel.query}>
            “Assess whether the curated geopolitical corpus is reliable enough to trade on.”
          </p>

          <div className={panel.meters}>
            <div className={panel.meter}>
              <span className={panel.meterLabel}>
                Confidence <b>0.71</b>
              </span>
              <span className={panel.track} aria-hidden="true">
                <i style={{ width: "71%" }} />
              </span>
            </div>
            <div className={panel.meter}>
              <span className={panel.meterLabel}>
                Consensus <b>0.64</b>
              </span>
              <span className={`${panel.track} ${panel.trackMuted}`} aria-hidden="true">
                <i style={{ width: "64%" }} />
              </span>
            </div>
            <dl className={panel.facts}>
              <div>
                <dt>Agents</dt>
                <dd>3</dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>18</dd>
              </div>
              <div>
                <dt>Cost</dt>
                <dd>$0.42</dd>
              </div>
            </dl>
          </div>

          <ul className={panel.claims}>
            {CLAIMS.map((claim) => (
              <li key={claim.statement} className={panel.claim}>
                <div className={panel.claimHead}>
                  <span className={`${panel.kind} ${panel[claim.kind.toLowerCase()] ?? ""}`}>
                    {claim.kind}
                  </span>
                  <span className={panel.claimConfidence}>{pct(claim.confidence)}</span>
                </div>
                <p className={panel.claimText}>{claim.statement}</p>
                <div className={panel.evidence}>
                  {claim.evidence.map((item) => (
                    <span key={item.source} className={panel.chip}>
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M9.5 14.5 14.5 9.5M8.4 12.1 6.9 13.6a3.2 3.2 0 1 0 4.5 4.5l1.5-1.5M15.6 11.9l1.5-1.5a3.2 3.2 0 1 0-4.5-4.5l-1.5 1.5"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        />
                      </svg>
                      {item.source}
                      <b>{item.reliability.toFixed(2)}</b>
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>

          <div className={panel.conflict}>
            <span className={panel.conflictLabel}>Unresolved disagreement</span>
            <p className={panel.conflictQuestion}>Is the corpus tradeable as it stands today?</p>
            <div className={panel.stances}>
              <div className={panel.stance}>
                <span className={panel.stanceAgent}>Markets Agent</span>
                <p>Yes, for positions sized to the three well-covered topics only.</p>
              </div>
              <div className={`${panel.stance} ${panel.stanceAgainst}`}>
                <span className={panel.stanceAgent}>Data Quality Agent</span>
                <p>No — the sampling bias makes any corpus-wide read unsound.</p>
              </div>
            </div>
          </div>

          <div className={panel.contributions}>
            <span className={panel.contribLabel}>Contribution weights</span>
            {CONTRIBUTIONS.map((row) => (
              <div key={row.agent} className={panel.contribRow}>
                <span className={panel.contribAgent}>{row.agent}</span>
                <span className={panel.contribTrack} aria-hidden="true">
                  <i style={{ width: pct(row.weight) }} />
                </span>
                <span className={panel.contribValue}>{row.weight.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </div>
      </Reveal>

      <p className={panel.caption}>
        Illustrative. A live job renders this same structure at <code>/jobs/:id</code>, and the
        same payload is served from <code>GET /v1/jobs/:id/intelligence</code>.
      </p>
    </section>
  );
}
