export const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

export const pct1 = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function timeAgo(iso: string | Date | null): string {
  if (!iso) return "—";
  const then = typeof iso === "string" ? Date.parse(iso) : iso.getTime();
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Terminal states are styled distinctly from in-flight ones. */
export const STATUS_TONE: Record<string, string> = {
  CREATED: "bg-zinc-500/10 text-zinc-500 border-zinc-500/25",
  QUEUED: "bg-zinc-500/10 text-zinc-500 border-zinc-500/25",
  ASSIGNED: "bg-blue-500/10 text-blue-500 border-blue-500/25",
  RUNNING: "bg-blue-500/10 text-blue-500 border-blue-500/25",
  SUBMITTED: "bg-violet-500/10 text-violet-500 border-violet-500/25",
  VALIDATING: "bg-violet-500/10 text-violet-500 border-violet-500/25",
  CONSENSUS: "bg-amber-500/10 text-amber-500 border-amber-500/25",
  RESOLVED: "bg-emerald-500/10 text-emerald-500 border-emerald-500/25",
  FAILED: "bg-red-500/10 text-red-500 border-red-500/25",
  CANCELLED: "bg-zinc-500/10 text-zinc-500 border-zinc-500/25",
};

export const IN_FLIGHT = new Set([
  "CREATED", "QUEUED", "ASSIGNED", "RUNNING", "SUBMITTED", "VALIDATING", "CONSENSUS",
]);

export const SEVERITY_TONE: Record<string, string> = {
  LOW: "text-zinc-500",
  MEDIUM: "text-amber-500",
  HIGH: "text-orange-500",
  CRITICAL: "text-red-500",
};
