import Link from "next/link";
import { api, attempt, fetchJson } from "@/lib/api";
import { pct, timeAgo } from "@/lib/format";
import { ApiDown, Card, Empty, SectionHead, StatStrip, StatusBadge } from "@/components/ui";
import { CreateJobForm } from "@/components/create-job-form";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [jobs, stats] = await Promise.all([
    attempt(() => api.listJobs({ limit: 12 })),
    attempt(() =>
      fetchJson<{
        data: { jobs: number; resolved: number; activeAgents: number; evidenceItems: number };
      }>("/v1/stats"),
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
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:gap-8">
        {/* Sticky: the list beside it runs past a screen, and the form is the
            thing you come back to after reading one. */}
        <section className="lg:sticky lg:top-10">
          <SectionHead>New intelligence job</SectionHead>
          <Card className="p-5">
            <CreateJobForm />
          </Card>
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
