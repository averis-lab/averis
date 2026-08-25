import Link from "next/link";
import { STATUS_TONE } from "@/lib/format";

export function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-surface ${className}`}>{children}</div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.CREATED;
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium tracking-wide ${tone}`}
    >
      {status}
    </span>
  );
}

/**
 * A labelled proportion bar.
 *
 * Confidence and consensus are shown as separate bars everywhere in this UI,
 * never merged into one number — a cohort can be confident and split, and
 * collapsing the two would hide exactly the disagreement the protocol works
 * to surface.
 */
export function Meter({
  label,
  value,
  hint,
  tone = "accent",
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "accent" | "emerald" | "amber";
}) {
  const width = `${Math.min(100, Math.max(0, value * 100))}%`;
  const fill =
    tone === "emerald" ? "bg-emerald-500" : tone === "amber" ? "bg-amber-500" : "bg-accent";

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-muted">{label}</span>
        <span className="font-mono text-sm tabular-nums">{(value * 100).toFixed(1)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full ${fill}`} style={{ width }} />
      </div>
      {hint ? <p className="mt-1.5 text-[11px] leading-snug text-muted">{hint}</p> : null}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl tabular-nums">{value}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-muted">{sub}</p> : null}
    </Card>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p> : null}
    </Card>
  );
}

export function ApiDown({ error }: { error: string }) {
  // "fetch failed" means nothing answered on the port at all, which is a
  // different fix from the API answering but failing to reach its database.
  // Telling someone to start Docker when the API simply is not running sends
  // them down the wrong path.
  const apiOffline = /fetch failed|ECONNREFUSED|Cannot reach|not reachable|timed out/i.test(error);

  return (
    <Card className="border-amber-500/30 bg-amber-500/5 p-5">
      <p className="text-sm font-medium text-amber-500">
        {apiOffline ? "The API process is not running" : "The API cannot reach its database"}
      </p>

      <ol className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted">
        {apiOffline ? (
          <li>
            1. Start the gateway: <Cmd>npm run dev:api</Cmd>
          </li>
        ) : (
          <li>
            1. Start Postgres and Redis: <Cmd>npm run infra:up</Cmd>
          </li>
        )}
        <li>
          2. Then the workers, so jobs actually run: <Cmd>npm run dev:workers</Cmd>
        </li>
        <li>
          3. Or start everything at once: <Cmd>npm run dev:all</Cmd>
        </li>
      </ol>

      <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
        Only the database-backed pages need Docker. The landing page, the{" "}
        <Link href="/whitepaper" className="text-accent underline-offset-2 hover:underline">
          whitepaper
        </Link>{" "}
        and{" "}
        <Link href="/datanets" className="text-accent underline-offset-2 hover:underline">
          Datanets
        </Link>{" "}
        do not.
      </p>

      <p className="mt-2 font-mono text-[11px] break-all text-muted/70">{error}</p>
    </Card>
  );
}

function Cmd({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-line px-1 py-0.5 font-mono text-[11px]">{children}</code>;
}
