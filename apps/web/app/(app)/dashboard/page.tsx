import Link from "next/link";
import { api, attempt, fetchJson } from "@/lib/api";
import { pct, timeAgo } from "@/lib/format";
import { ApiDown, Card, Empty, Stat, StatusBadge } from "@/components/ui";
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
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Jobs" value={String(stats.value.data.jobs)} />
          <Stat
            label="Resolved"
            value={String(stats.value.data.resolved)}
            sub="reached consensus"
          />
          <Stat label="Active agents" value={String(stats.value.data.activeAgents)} />
          <Stat
            label="Evidence"
            value={String(stats.value.data.evidenceItems)}
            sub="provenance records"
          />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <section>
          <h2 className="mb-3 text-sm font-semibold">New intelligence job</h2>
          <Card className="p-5">
            <CreateJobForm />
          </Card>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Recent jobs</h2>
          {jobs.value.length === 0 ? (
            <Empty
              title="No jobs yet"
              hint="Create one on the left, or run `npm run demo` for a scripted end-to-end run."
            />
          ) : (
            <div className="space-y-2">
              {jobs.value.map((job) => (
                <Link key={job.id} href={`/jobs/${job.id}`} className="block">
                  <Card className="p-4 transition-colors hover:border-accent/50">
                    <div className="flex items-start justify-between gap-3">
                      <p className="line-clamp-2 flex-1 text-sm leading-snug">{job.query}</p>
                      <StatusBadge status={job.status} />
                    </div>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
                      <span>{job.type}</span>
                      <span>·</span>
                      <span>{job.agentCount ?? job.requiredAgents} agents</span>
                      {job.evidenceCount ? (
                        <>
                          <span>·</span>
                          <span>{job.evidenceCount} evidence</span>
                        </>
                      ) : null}
                      {typeof job.confidence === "number" ? (
                        <>
                          <span>·</span>
                          <span className="text-emerald-500">
                            {pct(job.confidence)} confidence
                          </span>
                        </>
                      ) : null}
                      <span className="ml-auto">{timeAgo(job.createdAt)}</span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
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
