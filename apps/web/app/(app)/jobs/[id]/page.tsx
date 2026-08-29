import Link from "next/link";
import { notFound } from "next/navigation";
/* `api` stays imported for its types below — `typeof api.explain` and
   friends describe the report shapes. The calls go through `viewerApi()`. */
import { api, attempt, viewerApi } from "@/lib/api";
import { IN_FLIGHT, SEVERITY_TONE, pct, pct1, timeAgo } from "@/lib/format";
import { ApiDown, Card, Meter, StatusBadge } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: PageProps<"/jobs/[id]">) {
  const { id } = await params;

  /*
   * The viewer's own identity, so a job created under a wallet is readable by
   * the wallet that created it. The gateway answers 404 rather than 403 for
   * another account's job, so reading this as the application would make a
   * person's own job indistinguishable from one that never existed.
   */
  const client = await viewerApi();

  const job = await attempt(() => client.getJob(id));
  if (!job.ok) {
    if (job.error.includes("not found")) notFound();
    return <ApiDown error={job.error} />;
  }

  const inFlight = IN_FLIGHT.has(job.value.status);
  const resolved = job.value.status === "RESOLVED";
  const [report, why] = resolved
    ? await Promise.all([
        attempt(() => client.getIntelligence(id)),
        attempt(() => client.explain(id)),
      ])
    : [null, null];

  return (
    <div className="space-y-6">
      <AutoRefresh active={inFlight} />

      <div>
        <Link href="/dashboard" className="text-xs text-muted transition-colors hover:text-foreground">
          ← all jobs
        </Link>
        <div className="mt-2 flex items-start justify-between gap-4">
          <h1 className="max-w-3xl text-lg leading-snug font-semibold">{job.value.query}</h1>
          <StatusBadge status={job.value.status} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
          <span>{job.value.type}</span>
          <span>·</span>
          <span>{job.value.requiredAgents} agents required</span>
          <span>·</span>
          <span>{job.value.budget} USDC</span>
          <span>·</span>
          <span>{job.value.datanetIds.length} datanets</span>
          <span>·</span>
          <span>created {timeAgo(job.value.createdAt)}</span>
        </div>
      </div>

      <Lifecycle status={job.value.status} />

      {inFlight ? (
        <Card className="p-5">
          <p className="text-sm font-medium">Agents are working…</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            Each selected agent retrieves curated evidence and analyses it independently. This page
            updates itself as the job advances.
          </p>
        </Card>
      ) : null}

      {job.value.status === "FAILED" ? (
        <Card className="border-red-500/30 bg-red-500/5 p-5">
          <p className="text-sm font-medium text-red-500">Job failed</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            {job.value.failureReason ?? "No reason recorded."}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Failing is a valid outcome. A job whose merged confidence falls below its stated
            threshold is failed rather than shipped.
          </p>
        </Card>
      ) : null}

      {why?.ok ? <Why explanation={why.value.explanation} /> : null}
      {report?.ok ? <Report report={report.value} /> : null}
      {report && !report.ok ? <ApiDown error={report.error} /> : null}
    </div>
  );
}

const STAGES = [
  "CREATED", "QUEUED", "ASSIGNED", "RUNNING", "SUBMITTED", "VALIDATING", "CONSENSUS", "RESOLVED",
] as const;

function Lifecycle({ status }: { status: string }) {
  const failed = status === "FAILED" || status === "CANCELLED";
  const index = STAGES.indexOf(status as (typeof STAGES)[number]);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {STAGES.map((stage, i) => {
        const done = !failed && index >= 0 && i <= index;
        const current = stage === status;
        return (
          <span
            key={stage}
            className={`rounded-md border px-2 py-1 font-mono text-[10px] tracking-wide transition-colors ${
              current
                ? "border-accent bg-accent/10 text-accent"
                : done
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-500"
                  : "border-line text-muted"
            }`}
          >
            {stage}
          </span>
        );
      })}
      {failed ? (
        <span className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 font-mono text-[10px] text-red-500">
          {status}
        </span>
      ) : null}
    </div>
  );
}

const VERDICT_TONE: Record<string, string> = {
  SUPPORTED: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  DISPUTED: "border-accent/40 bg-accent/10 text-accent",
  THIN: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  UNSUPPORTED: "border-line bg-surface text-muted",
};

type Explanation = Awaited<ReturnType<typeof api.explain>>["explanation"];

/**
 * "Why this conclusion?"
 *
 * The numbers on this panel are not new — they were computed during the merge.
 * What is new is that the chain is followable: verdict, then the claims under
 * it, then the upstream vote volumes that gave each source its weight. That
 * last step is where the trail leaves the model entirely and lands on a
 * curation market someone staked on.
 */
function Why({ explanation }: { explanation: Explanation }) {
  const { reliability } = explanation;

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-xs font-semibold tracking-widest text-muted uppercase">
          Why this conclusion?
        </h2>
        <span
          className={`rounded-md border px-2 py-0.5 font-mono text-[11px] tracking-wide ${
            VERDICT_TONE[explanation.verdict] ?? VERDICT_TONE.UNSUPPORTED
          }`}
        >
          {explanation.verdict}
        </span>
      </div>

      {/* Three reliabilities, never one: they fail independently. */}
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Meter label="Evidence reliability" value={reliability.evidence} hint="upstream curation" />
        <Meter
          label="Reasoning reliability"
          value={reliability.reasoning}
          hint="deterministic evaluator"
          tone="emerald"
        />
        <div>
          <div className="mb-1.5 flex items-baseline justify-between gap-2">
            <span className="text-xs text-muted">Outcome reliability</span>
            <span className="font-mono text-xs text-muted">—</span>
          </div>
          <div className="h-1.5 rounded-full bg-line" />
          <p className="mt-1.5 text-[11px] text-muted">no prediction has resolved yet</p>
        </div>
      </div>

      <ol className="space-y-2">
        {explanation.reasons.map((reason, i) => (
          <li key={reason} className="flex gap-2.5 text-sm leading-relaxed">
            <span className="font-mono text-[11px] text-accent">{String(i + 1).padStart(2, "0")}</span>
            <span className="flex-1 text-muted">{reason}</span>
          </li>
        ))}
      </ol>

      {explanation.caveats.length > 0 ? (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-4">
          {explanation.caveats.map((caveat) => (
            <li key={caveat} className="flex gap-2 text-xs leading-relaxed text-amber-300/90">
              <span aria-hidden="true">!</span>
              <span className="flex-1">{caveat}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {explanation.claims.length > 0 ? (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="mb-3 text-xs font-semibold tracking-widest text-muted uppercase">
            Claim by claim
          </h3>
          <div className="space-y-2">
            {explanation.claims.map((claim) => (
              <details key={claim.statement} className="rounded-lg border border-line">
                <summary className="flex cursor-pointer items-start gap-2.5 p-3">
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                      VERDICT_TONE[claim.verdict] ?? VERDICT_TONE.UNSUPPORTED
                    }`}
                  >
                    {claim.verdict}
                  </span>
                  <span className="flex-1 text-sm leading-snug">{claim.statement}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">
                    {pct1(claim.confidence)}
                  </span>
                </summary>

                <div className="border-t border-line px-3 py-3">
                  <ol className="space-y-1.5">
                    {claim.reasons.map((reason, i) => (
                      <li key={reason} className="flex gap-2 text-xs leading-relaxed">
                        <span className="font-mono text-[10px] text-accent">{i + 1}.</span>
                        <span className="flex-1 text-muted">{reason}</span>
                      </li>
                    ))}
                  </ol>

                  {claim.evidence.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 border-t border-line pt-3">
                      {claim.evidence.map((item) => (
                        <li
                          key={`${item.source}-${item.stance}`}
                          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[11px]"
                        >
                          <span className={item.stance === "supports" ? "text-emerald-400" : "text-accent"}>
                            {item.stance === "supports" ? "+" : "−"}
                          </span>
                          <span className="text-muted">{item.source}</span>
                          <span className="text-foreground">{item.reliability.toFixed(2)}</span>
                          {item.curation ? (
                            <span className="text-muted/70">
                              {item.curation.upVotes}↑ / {item.curation.downVotes}↓ ·{" "}
                              {pct(item.curation.approvalRate)} approval
                              {item.curation.epoch === null ? "" : ` · epoch ${item.curation.epoch}`}
                            </span>
                          ) : (
                            <span className="text-muted/70">no upstream curation</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

type ReportData = Awaited<ReturnType<typeof api.getIntelligence>>;

function Report({ report }: { report: ReportData }) {
  const { intelligence: intel, contributions, agentOutputs, evidence } = report;

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <h2 className="text-xs font-semibold tracking-widest text-muted uppercase">
          Final intelligence
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed">{intel.summary}</p>

        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <Meter
            label="Confidence"
            value={intel.confidence}
            tone="emerald"
            hint="Support-weighted confidence, discounted when the cohort is split."
          />
          <Meter
            label="Consensus"
            value={intel.consensusScore}
            tone="amber"
            hint={
              intel.corroboration
                ? `${intel.corroboration.cohortSize} of ${intel.corroboration.expected} agents corroborating. Agreement is scaled by that breadth, so a lone agent cannot report consensus.`
                : "How much the agents actually agreed, reported separately from confidence."
            }
          />
        </div>

        {intel.corroboration?.short ? (
          <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-500">
            {intel.corroboration.cohortSize === 1
              ? `Only 1 of ${intel.corroboration.expected} agents produced usable output. Nothing below is corroborated by a second analyst, and the consensus score is zero for that reason.`
              : `Only ${intel.corroboration.cohortSize} of ${intel.corroboration.expected} agents finished, so the consensus score is discounted to reflect the narrower corroboration.`}
          </p>
        ) : null}

        <p className="mt-4 font-mono text-[11px] text-muted">
          strategy {intel.strategy} · {contributions.length} agents · {evidence.length} evidence
          items
        </p>
      </Card>

      {intel.recommendation ? (
        <Card className="p-5">
          <h3 className="text-xs font-semibold tracking-widest text-muted uppercase">
            Recommendation
          </h3>
          <p className="mt-2 text-sm font-medium">{intel.recommendation.action}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            {intel.recommendation.rationale}
          </p>
          <p className="mt-2 font-mono text-[11px] text-muted">
            confidence {pct1(intel.recommendation.confidence)}
          </p>
        </Card>
      ) : null}

      <section>
        <h3 className="mb-3 text-sm font-semibold">Claims ({intel.claims.length})</h3>
        <div className="space-y-2.5">
          {intel.claims.map((claim, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  {claim.kind}
                </span>
                <p className="flex-1 text-sm leading-snug">{claim.statement}</p>
              </div>

              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
                <span>confidence {pct1(claim.confidence)}</span>
                <span>·</span>
                <span>support {pct1(claim.support)}</span>
                <span>·</span>
                <span>{claim.supportedBy.length} agent(s)</span>
                {claim.contradictedBy.length > 0 ? (
                  <>
                    <span>·</span>
                    <span className="text-amber-500">
                      contradicted by {claim.contradictedBy.length}
                    </span>
                  </>
                ) : null}
              </div>

              {claim.supportingEvidence.length > 0 ? (
                <ul className="mt-3 space-y-1 border-l-2 border-line pl-3">
                  {claim.supportingEvidence.slice(0, 3).map((e, j) => (
                    <li key={j} className="text-[11px] leading-snug">
                      <span className="font-mono text-muted">{e.source}</span>
                      {e.title ? <span className="text-muted"> — {e.title}</span> : null}
                      <span className="ml-1 font-mono text-muted">
                        (reliability {e.reliability.toFixed(2)})
                      </span>
                    </li>
                  ))}
                  {claim.supportingEvidence.length > 3 ? (
                    <li className="text-[11px] text-muted">
                      +{claim.supportingEvidence.length - 3} more
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] text-amber-500">No evidence cited.</p>
              )}
            </Card>
          ))}
        </div>
      </section>

      {intel.disagreements.length > 0 ? (
        <section>
          <h3 className="mb-1 text-sm font-semibold">
            Disagreements ({intel.disagreements.length})
          </h3>
          <p className="mb-3 text-xs leading-relaxed text-muted">
            Where agents genuinely conflicted. Surfaced rather than averaged into a middle position
            no agent actually held.
          </p>
          <div className="space-y-2.5">
            {intel.disagreements.map((d, i) => (
              <Card key={i} className="border-amber-500/25 p-4">
                <div className="flex flex-wrap gap-3 font-mono text-[11px] text-muted">
                  <span className="text-emerald-500">support {pct1(d.supportWeight)}</span>
                  <span className="text-amber-500">oppose {pct1(d.opposeWeight)}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {d.positions.map((p, j) => (
                    <li key={j} className="border-l-2 border-line pl-3 text-xs leading-snug">
                      <span className="font-mono text-[10px] text-muted">
                        {p.agentId.slice(0, 8)} @ {pct(p.confidence)}
                      </span>
                      <p className="mt-0.5">{p.statement}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {intel.risks.length > 0 ? (
        <section>
          <h3 className="mb-3 text-sm font-semibold">Risks</h3>
          <Card className="divide-y divide-line">
            {intel.risks.map((risk, i) => (
              <div key={i} className="flex items-start gap-3 p-4">
                <span
                  className={`font-mono text-[10px] ${SEVERITY_TONE[risk.severity] ?? "text-muted"}`}
                >
                  {risk.severity}
                </span>
                <p className="flex-1 text-xs leading-snug">{risk.description}</p>
                <span className="font-mono text-[11px] text-muted">
                  {pct(risk.likelihood)}
                </span>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <section>
        <h3 className="mb-1 text-sm font-semibold">Agent contributions</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Weight is earned from measured performance — domain reputation, accuracy, calibration and
          evidence quality. Self-reported confidence carries the least weight of any factor.
        </p>
        <div className="space-y-2.5">
          {contributions.map((c) => {
            const output = agentOutputs.find((o) => o.agentId === c.agentId);
            return (
              <Card key={c.agentId} className="p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium">{c.agentName}</p>
                  <span className="font-mono text-xs tabular-nums">{pct1(c.weight)} weight</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${c.weight * 100}%` }} />
                </div>
                <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
                  <span>agreement {pct(c.agreement)}</span>
                  <span>·</span>
                  <span>{output?.claims.length ?? 0} claims</span>
                  <span>·</span>
                  <span>self-confidence {pct(output?.confidence ?? 0)}</span>
                </div>
                {output?.evaluation ? (
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-muted sm:grid-cols-4">
                    <span>evidence {output.evaluation.evidenceQuality.toFixed(2)}</span>
                    <span>consistency {output.evaluation.internalConsistency.toFixed(2)}</span>
                    <span>specificity {output.evaluation.specificity.toFixed(2)}</span>
                    <span>corroboration {output.evaluation.corroboration.toFixed(2)}</span>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-sm font-semibold">Provenance ({evidence.length})</h3>
        <p className="mb-3 text-xs leading-relaxed text-muted">
          Every item was retrieved by the tool runtime, not authored by a model. Reliability is the
          upstream stake-backed curation score.
        </p>
        <Card className="divide-y divide-line">
          {evidence.slice(0, 20).map((e) => (
            <div key={e.id} className="flex items-start gap-3 p-3">
              <span className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {e.type}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs">{e.title ?? "untitled"}</p>
                <p className="truncate font-mono text-[10px] text-muted">{e.source}</p>
              </div>
              <span className="font-mono text-[11px] text-muted">{e.reliability.toFixed(2)}</span>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}
