"use client";

import { useState } from "react";
import styles from "@/app/(landing)/landing.module.css";
import s from "./sections.module.css";
import { Reveal } from "./reveal";

/**
 * Both snippets are the real surface: the SDK call is the one documented in
 * the README, and the curl hits the same endpoint with the same auth header.
 */
const TABS = {
  sdk: {
    label: "SDK",
    language: "ts",
    code: `import { createClient } from "@averis/sdk";

const client = createClient({
  baseUrl: "http://localhost:4000",
  apiKey: process.env.AVERIS_API_KEY,
});

const report = await client.runJob({
  type: "dataset-evaluation",
  query: "Assess whether the curated corpus is reliable enough to trade on.",
  requiredCapabilities: ["markets", "geopolitics"],
  requiredAgents: 3,
  budget: 3,
});

for (const claim of report.intelligence.claims) {
  console.log(claim.statement, claim.supportingEvidence);
}`,
  },
  curl: {
    label: "cURL",
    language: "sh",
    code: `curl -X POST http://localhost:4000/v1/jobs \\
  -H "Authorization: Bearer $AVERIS_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "type": "dataset-evaluation",
    "query": "Assess whether the curated corpus is reliable enough to trade on.",
    "requiredCapabilities": ["markets", "geopolitics"],
    "requiredAgents": 3,
    "budget": 3
  }'

curl http://localhost:4000/v1/jobs/$JOB_ID/intelligence \\
  -H "Authorization: Bearer $AVERIS_API_KEY"`,
  },
} as const;

type TabKey = keyof typeof TABS;

const ENDPOINTS = [
  { method: "POST", path: "/v1/jobs", note: "Create an intelligence job" },
  { method: "GET", path: "/v1/jobs/:id", note: "Status and lifecycle audit trail" },
  { method: "GET", path: "/v1/jobs/:id/intelligence", note: "Merged result and provenance" },
  { method: "GET", path: "/v1/jobs/:id/explain", note: "The reasoning chain behind the verdict" },
  { method: "GET", path: "/v1/datanets", note: "Browse upstream curated datasets" },
  { method: "GET", path: "/v1/agents", note: "Registry with reputation" },
];

export function Developers() {
  const [tab, setTab] = useState<TabKey>("sdk");

  return (
    <section className={styles.section} id="developers">
      <Reveal className={styles.sectionHead}>
        <span className={styles.eyebrow}>For developers</span>
        <h2 className={styles.sectionTitle}>One call in, an auditable report out.</h2>
        <p className={styles.sectionLede}>
          <code className={s.inlineCode}>runJob</code> throws if the job ends FAILED rather than
          returning a partial result — a caller who forgot to check status would otherwise act on
          intelligence the protocol declined to stand behind. Every endpoint below can also be
          called from the in-app playground, which shows the equivalent curl and SDK code for
          whatever you just sent.
        </p>
      </Reveal>

      <div className={s.devGrid}>
        <div className={s.codeCard}>
          <div className={s.tabs} role="tablist" aria-label="Example format">
            {(Object.keys(TABS) as TabKey[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`panel-${key}`}
                className={`${s.tab} ${tab === key ? s.tabActive : ""}`}
                onClick={() => setTab(key)}
              >
                {TABS[key].label}
              </button>
            ))}
            <span className={s.tabLang}>{TABS[tab].language}</span>
          </div>

          <pre
            className={s.code}
            role="tabpanel"
            id={`panel-${tab}`}
            aria-labelledby={`tab-${tab}`}
            tabIndex={0}
          >
            <code>{TABS[tab].code}</code>
          </pre>
        </div>

        <div className={s.endpoints}>
          <span className={s.endpointsLabel}>Gateway</span>
          <ul>
            {ENDPOINTS.map((endpoint) => (
              <li key={endpoint.path}>
                <span className={`${s.method} ${endpoint.method === "POST" ? s.methodPost : ""}`}>
                  {endpoint.method}
                </span>
                <code>{endpoint.path}</code>
                <span className={s.endpointNote}>{endpoint.note}</span>
              </li>
            ))}
          </ul>
          <p className={s.endpointsFoot}>
            Bearer auth per account key. Jobs are scoped to the key that created them.
          </p>
        </div>
      </div>
    </section>
  );
}
