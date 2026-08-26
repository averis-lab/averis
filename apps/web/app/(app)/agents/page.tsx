import { attempt, fetchJson } from "@/lib/api";
import { pct1 } from "@/lib/format";
import { ApiDown, Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

interface AgentRow {
  id: string;
  name: string;
  status: string;
  capabilities: Array<{ domain: string; skill: string | null; declared: number }>;
  modelProvider: string;
  modelName: string;

  activeAssignments: number;
  maxConcurrent: number;
  reputation: {
    overall: number;
    accuracy: number;
    calibration: number;
    consistency: number;
    evidenceQuality: number;
    sampleSize: number;
  };

}

export default async function AgentsPage() {
  const result = await attempt(
    async () => (await fetchJson<{ data: AgentRow[] }>("/v1/agents")).data,
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Agent registry</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
          Selection is capability-aware, not a leaderboard: a cohort is scored for covering
          different specializations so its errors do not correlate. Reputation is earned from
          measured performance only — capital is not an input.
        </p>
      </div>

      {!result.ok ? (
        <ApiDown error={result.error} />
      ) : result.value.length === 0 ? (
        <Empty title="No agents registered" hint="Run `npm run db:seed` to populate the registry." />
      ) : (
        <div className="space-y-3">
          {result.value.map((agent) => (
            <Card key={agent.id} className="p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{agent.name}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-muted">
                    {agent.modelProvider}/{agent.modelName} ·{" "}
                    {agent.activeAssignments}/{agent.maxConcurrent} slots
                  </p>
                </div>
                <span className="rounded border border-line px-2 py-0.5 font-mono text-[10px] text-muted">
                  {agent.status}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-1">
                {agent.capabilities.map((c) => (
                  <span
                    key={`${c.domain}-${c.skill ?? ""}`}
                    className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent"
                  >
                    {c.skill ? `${c.domain}/${c.skill}` : c.domain}
                  </span>
                ))}
              </div>

              {/* Only what the deterministic evaluator measures today. Accuracy
                  and calibration are scored from resolved predictions, and no
                  prediction has reached a deadline yet — printing them beside
                  these three would read as five measurements when it is three. */}
              <div className="mt-4 grid grid-cols-3 gap-3">
                {(
                  [
                    ["overall", agent.reputation.overall],
                    ["consistency", agent.reputation.consistency],
                    ["evidence", agent.reputation.evidenceQuality],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <p className="text-[10px] text-muted">{label}</p>
                    <p className="font-mono text-sm tabular-nums">{pct1(value)}</p>
                  </div>
                ))}
              </div>

              <div className="mt-3 space-y-1 text-[11px] text-muted">
                <p>
                  {agent.reputation.sampleSize === 0
                    ? "No track record yet — scored at the neutral prior, so it can still be selected and earn one."
                    : `${agent.reputation.sampleSize} observation(s) behind these scores.`}
                </p>
                <p>Accuracy and calibration arrive with resolved predictions.</p>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
