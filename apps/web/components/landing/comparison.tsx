import styles from "@/app/(landing)/landing.module.css";
import s from "./sections.module.css";
import { Reveal } from "./reveal";

const COLUMNS = ["One model call", "Plain fan-out", "Averis"] as const;

/** `true` present, `false` absent, `"partial"` present but unverifiable. */
const ROWS: { property: string; values: (boolean | "partial")[] }[] = [
  { property: "Several independent analyses", values: [false, true, true] },
  { property: "Claims linked to retrieved evidence", values: [false, "partial", true] },
  { property: "Fabricated sources rejected by the runtime", values: [false, false, true] },
  { property: "Disagreement preserved, not averaged", values: [false, false, true] },
  { property: "Deterministic scoring, no model grading a model", values: [false, false, true] },
  { property: "Weighting by measured past accuracy", values: [false, false, true] },
  { property: "Budget enforced before execution", values: [false, "partial", true] },
  { property: "Full lifecycle audit trail", values: [false, false, true] },
];

function Mark({ value }: { value: boolean | "partial" }) {
  if (value === "partial") {
    return (
      <span className={`${s.mark} ${s.markPartial}`} title="Possible, but not enforced">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 12h12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className={s.srOnly}>Partial</span>
      </span>
    );
  }
  return value ? (
    <span className={`${s.mark} ${s.markYes}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m5.5 12.5 4.2 4.2L18.5 7.9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className={s.srOnly}>Yes</span>
    </span>
  ) : (
    <span className={`${s.mark} ${s.markNo}`}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
      <span className={s.srOnly}>No</span>
    </span>
  );
}

export function Comparison() {
  return (
    <section className={styles.section} id="compare">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>The difference</span>
        <h2 className={styles.sectionTitle}>
          Asking three models is not the same as coordinating three analysts.
        </h2>
      </Reveal>

      <Reveal className={s.matrixWrap} delay={0.06}>
        <table className={s.matrix}>
          <thead>
            <tr>
              <th scope="col">
                <span className={s.srOnly}>Property</span>
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className={column === "Averis" ? s.matrixOwn : undefined}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.property}>
                <th scope="row">{row.property}</th>
                {row.values.map((value, i) => (
                  <td
                    key={COLUMNS[i]}
                    className={COLUMNS[i] === "Averis" ? s.matrixOwn : undefined}
                  >
                    <Mark value={value} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Reveal>

      <Reveal as="ul" className={s.legend} delay={0.1}>
        <li>
          <Mark value={true} /> Enforced by the protocol
        </li>
        <li>
          <Mark value="partial" /> Possible, but nothing enforces it
        </li>
        <li>
          <Mark value={false} /> Not available
        </li>
      </Reveal>
    </section>
  );
}
