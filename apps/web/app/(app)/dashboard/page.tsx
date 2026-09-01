import Link from "next/link";
import { attempt, fetchJson, viewerApi, walletLoginEnabled } from "@/lib/api";
import { viewerToken } from "@/lib/session";
import { pct, timeAgo } from "@/lib/format";
import { ApiDown, Card, Empty, SectionHead, StatStrip, StatusBadge } from "@/components/ui";
import { ConnectGate } from "@/components/wallet";
import { CreateJobForm } from "@/components/create-job-form";

export const dynamic = "force-dynamic";

export default async function Home() {
  /*
   * Read as the viewer, not as the application.
   *
   * The gateway scopes both the list and the stats to the requester, so these
   * have to speak with the same identity the create action does — otherwise a
   * person creates a job under their wallet and is redirected to a page that
   * reads under the app key and answers 404, which looks like the job was lost.
   */
  const token = await viewerToken();
  const client = await viewerApi();

  const [jobs, stats] = await Promise.all([
    attempt(() => client.listJobs({ limit: 12 })),
    attempt(() =>
      fetchJson<{
        data: {
          jobs: number;
          resolved: number;
          activeAgents: number;
          evidenceItems: number;
          metrics: {
            agentRuns: number;
            costUsd: number;
            avgDurationMs: number;
            maxDurationMs: number;
            failedJobs: number;
            /** Null until a job has actually finished; see the endpoint. */
            failureRate: number | null;
          };
        };
      }>("/v1/stats", undefined, token),
    ),
  ]);

  if (!jobs.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ApiDown error={jobs.error} />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <Header />

      {stats.ok ? (
        <div className="space-y-3">
          <StatStrip
            items={[
              { label: "Jobs", value: String(stats.value.data.jobs), sub: "created" },
              {
                label: "Resolved",
                value: String(stats.value.data.resolved),
                sub: "reached consensus",
              },
              {
                label: "Active agents",
                value: String(stats.value.data.activeAgents),
                sub: "available to a cohort",
              },
              {
                label: "Evidence",
                value: String(stats.value.data.evidenceItems),
                sub: "provenance records",
              },
            ]}
          />

          {/* Measured per run, never estimated from a price list. */}
          <StatStrip items={runMetrics(stats.value.data.metrics)} />
        </div>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:gap-8">
        {/* Sticky: the list beside it runs past a screen, and the form is the
            thing you come back to after reading one. */}
        <section className="lg:sticky lg:top-10">
          <SectionHead>New intelligence job</SectionHead>
          {/* The form is hidden rather than shown-and-refused when a wallet is
              required and absent: the action would reject the submission
              anyway, and offering a button that cannot work is worse than
              saying plainly what is missing. */}
          {walletLoginEnabled() && !token ? (
            <ConnectGate />
          ) : (
            <Card className="p-5">
              <CreateJobForm />
            </Card>
          )}
        </section>

        <section>
          <SectionHead aside={jobs.value.length > 0 ? `${jobs.value.length} shown` : undefined}>
            Recent jobs
          </SectionHead>

          {jobs.value.length === 0 ? (
            <Empty
              title="No jobs yet"
              hint="Start one with the form, or run `npm run demo` for a scripted end-to-end run."
            />
          ) : (
            /* One panel with ruled rows rather than a stack of bordered cards:
               twelve cards draw twelve outlines around twelve one-line facts. */
            <Card className="divide-y divide-line overflow-hidden">
              {jobs.value.map((job) => (
                <Link
                  key={job.id}
                  href={`/jobs/${job.id}`}
                  className="block px-4 py-3.5 transition-colors hover:bg-line/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="line-clamp-2 flex-1 text-sm leading-snug">{job.query}</p>
                    <StatusBadge status={job.status} />
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-muted">
                    <span>{job.type}</span>
                    <Dot />
                    <span>{job.agentCount ?? job.requiredAgents} agents</span>
                    {job.evidenceCount ? (
                      <>
                        <Dot />
                        <span>{job.evidenceCount} evidence</span>
                      </>
                    ) : null}
                    {typeof job.confidence === "number" ? (
                      <>
                        <Dot />
                        <span className="text-emerald-500">{pct(job.confidence)} confidence</span>
                      </>
                    ) : null}
                    {/* Pushed right on one line, but it wraps with the rest
                        rather than being stranded alone on a narrow column. */}
                    <span className="ml-auto whitespace-nowrap">{timeAgo(job.createdAt)}</span>
                  </div>
                </Link>
              ))}
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The run metrics, formatted for reading rather than for precision.
 *
 * Every figure carries what it is over, because each has a different
 * denominator: cost and latency are per agent run, the failure rate is over
 * terminal jobs only. A row of bare numbers would invite the reader to compare
 * four things that are not on the same base.
 */
function runMetrics(m: {
  agentRuns: number;
  costUsd: number;
  avgDurationMs: number;
  maxDurationMs: number;
  failedJobs: number;
  failureRate: number | null;
}): { label: string; value: string; sub?: string }[] {
  return [
    {
      label: "Spend",
      value: m.costUsd > 0 ? `$${m.costUsd.toFixed(2)}` : "$0.00",
      sub: "measured, across all runs",
    },
    {
      label: "Agent runs",
      value: String(m.agentRuns),
      sub: "completed analyses",
    },
    {
      label: "Avg latency",
      value: m.avgDurationMs > 0 ? formatMs(m.avgDurationMs) : "—",
      sub: m.maxDurationMs > 0 ? `slowest ${formatMs(m.maxDurationMs)}` : "per agent run",
    },
    {
      label: "Failure rate",
      // A rate over nothing is not zero; it is not yet a rate.
      value: m.failureRate === null ? "—" : `${(m.failureRate * 100).toFixed(0)}%`,
      sub:
        m.failureRate === null
          ? "no job has finished yet"
          : `${m.failedJobs} of the jobs that finished`,
    },
  ];
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function Dot() {
  return (
    <span aria-hidden className="text-muted/40">
      ·
    </span>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Intelligence jobs</h1>
      <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
        A job asks several specialist agents to independently turn curated Datanet content into
        structured intelligence. Their outputs are scored, weighted and merged — and where they
        genuinely disagree, the disagreement is reported rather than averaged away.
      </p>
    </div>
  );
}
