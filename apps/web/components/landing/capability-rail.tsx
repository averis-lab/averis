import s from "./sections.module.css";

/**
 * A moving rail of the protocol's real vocabulary.
 *
 * The domains are the capability tags the seeded cohort declares and the tools
 * are the ones the agent runtime actually exposes — a marquee of invented
 * partner logos would say nothing, while this says what a job can ask for and
 * what an agent can reach for.
 */
const DOMAINS = [
  "markets",
  "geopolitics",
  "research",
  "crypto",
  "defi",
  "solana",
  "security",
  "ai",
  "robotics",
  "general",
];

const RUNTIME = [
  "reppo_list_datanets",
  "reppo_search_data",
  "reppo_get_datanet_data",
  "compute_evidence_stats",
  "http_get",
  "Onchain Analyst",
  "Research Agent",
  "Security Agent",
  "Markets Agent",
  "Data Quality Agent",
];

/** The track is rendered twice; the animation resets exactly at the seam. */
function Track({ items, kind }: { items: string[]; kind: "domain" | "runtime" }) {
  return (
    <>
      {[0, 1].map((copy) => (
        <div key={copy} className={s.railTrack} aria-hidden={copy === 1 ? "true" : undefined}>
          {items.map((item) => (
            <span key={item} className={kind === "domain" ? s.railDomain : s.railRuntime}>
              {kind === "runtime" && <i className={s.railDot} aria-hidden="true" />}
              {item}
            </span>
          ))}
        </div>
      ))}
    </>
  );
}

export function CapabilityRail() {
  return (
    <section className={s.rail} aria-label="Capabilities and runtime tools">
      <p className={s.railCaption}>
        Five specialist agents, ten declared capabilities, one shared evidence runtime
      </p>

      <div className={s.railRow}>
        <div className={s.railMotion}>
          <Track items={DOMAINS} kind="domain" />
        </div>
      </div>

      <div className={s.railRow}>
        <div className={`${s.railMotion} ${s.railReverse}`}>
          <Track items={RUNTIME} kind="runtime" />
        </div>
      </div>
    </section>
  );
}
