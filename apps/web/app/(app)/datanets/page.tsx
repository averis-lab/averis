import { api, attempt } from "@/lib/api";
import { pct1 } from "@/lib/format";
import { ApiDown, Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Datanet {
  id: string;
  name: string;
  description: string;
  domains: string[];
  curation: { approvalRate: number; upVoteVolume: number; downVoteVolume: number; status: string };
  accessFee: number;
}

export default async function DatanetsPage() {
  const result = await attempt(() => api.listDatanets({ limit: 30 }) as Promise<Datanet[]>);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Datanets</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
          Curated datasets read from Reppo over its public API. Domains are inferred locally so
          jobs can be matched to capability-appropriate agents; the approval rate is the upstream
          stake-backed curation signal, which becomes the reliability weight on any evidence drawn
          from a datanet.
        </p>
      </div>

      {!result.ok ? (
        <ApiDown error={result.error} />
      ) : result.value.length === 0 ? (
        <Empty title="No datanets returned" hint="The upstream data network returned an empty list." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {result.value.map((datanet) => (
            <Card key={datanet.id} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-medium leading-snug">{datanet.name}</p>
                <span className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-muted">
                  {datanet.curation.status}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">
                {datanet.description || "No description provided upstream."}
              </p>
              <div className="mt-3 flex flex-wrap gap-1">
                {datanet.domains.map((domain) => (
                  <span
                    key={domain}
                    className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent"
                  >
                    {domain}
                  </span>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
                <span className="text-emerald-500">
                  {pct1(datanet.curation.approvalRate)} approval
                </span>
                <span>·</span>
                <span>{formatVolume(datanet.curation.upVoteVolume)} up</span>
                <span>·</span>
                <span>{formatVolume(datanet.curation.downVoteVolume)} down</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function formatVolume(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}
