import Link from "next/link";
import { notFound } from "next/navigation";
import { attempt, fetchJson } from "@/lib/api";
import { viewerToken } from "@/lib/session";
import { AUTOMATION_ENABLED } from "@/lib/features";
import { ConnectGate } from "@/components/wallet";
import { pct, timeAgo } from "@/lib/format";
import { ApiDown, Card, Empty, Stat } from "@/components/ui";
import {
  EvaluatePanel,
  ModeSwitch,
  ResetBreaker,
  StartStop,
  SweepButton,
} from "@/components/automation/controls";
import { recentResolvedJobs } from "@/app/automation-actions";
import {
  EVENT_TONE,
  usd,
  type AutomationEventView,
  type AutomationView,
  type DriverView,
  type PositionView,
  type TradePolicyView,
} from "@/lib/automation";

export const dynamic = "force-dynamic";

export default async function AutomationDetailPage({ params }: PageProps<"/automation/[id]">) {
  // Gated: phase 5 is not reachable yet, and a route that renders while the
  // navigation says "soon" is the same as no gate at all.
  if (!AUTOMATION_ENABLED) notFound();

  const { id } = await params;
  const token = await viewerToken();

  if (Boolean(process.env["PRIVY_APP_ID"]?.trim()) && !token) return <ConnectGate />;

  const detail = await attempt(() =>
    fetchJson<{ data: AutomationView; driver: DriverView; priceSource: string }>(
      `/v1/automations/${id}`,
      undefined,
      token,
    ),
  );
  if (!detail.ok) {
    if (detail.error.includes("404")) notFound();
    return <ApiDown error={detail.error} />;
  }

  const [positions, events, jobs] = await Promise.all([
    attempt(() =>
      fetchJson<{ data: PositionView[] }>(`/v1/automations/${id}/positions`, undefined, token),
    ),
    attempt(() =>
      fetchJson<{ data: AutomationEventView[] }>(`/v1/automations/${id}/events`, undefined, token),
    ),
    recentResolvedJobs(),
  ]);

  const automation = detail.value.data;
  const { breaker } = automation.stats;
  const open = positions.ok ? positions.value.data.filter((p) => p.status === "OPEN") : [];
  const closed = positions.ok ? positions.value.data.filter((p) => p.status === "CLOSED") : [];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/automation"
          className="text-xs text-muted transition-colors hover:text-foreground"
        >
          ← all automations
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-lg font-semibold tracking-tight">{automation.name}</h1>
          <p className="font-mono text-[11px] text-muted">
            {automation.mode} · {automation.active ? "started" : "stopped"} · driver{" "}
            {detail.value.driver.name} · prices {detail.value.priceSource}
          </p>
        </div>
        <p className="mt-1.5 font-mono text-[11px] text-muted">
          {automation.capabilities.join(" · ") || "no capability filter"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Open" value={String(automation.stats.openPositions)} sub="positions" />
        <Stat label="Deployed" value={usd(automation.stats.deployedUsd)} sub="at risk now" />
        <Stat
          label="Closed"
          value={String(automation.stats.closedTrades)}
          sub={
            automation.stats.closedTrades > 0
              ? `${automation.stats.wins} up, 7-day window`
              : "7-day window"
          }
        />
        <Stat
          label="Realised"
          value={usd(automation.stats.realizedPnlUsd)}
          sub={
            automation.stats.closedTrades < 20
              ? `${automation.stats.closedTrades} trades — not a record yet`
              : "7-day window"
          }
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
        <div className="space-y-4">
          {breaker.paused ? (
            <Card className="border-amber-500/30 bg-amber-500/5 p-4">
              <ResetBreaker id={automation.id} reason={breaker.reason ?? "tripped"} />
            </Card>
          ) : null}

          <Card className="p-4">
            <StartStop id={automation.id} active={automation.active} />
          </Card>

          <Card className="p-4">
            <p className="mb-2 text-xs font-medium text-muted">Mode</p>
            <ModeSwitch
              id={automation.id}
              mode={automation.mode}
              driverSpends={detail.value.driver.spendsRealMoney}
            />
          </Card>

          <Card className="p-4">
            <SweepButton id={automation.id} />
          </Card>

          <PolicyCard policy={automation.policy} />
        </div>

        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-sm font-semibold">Run a job past the policy</h2>
            <Card className="p-4">
              <EvaluatePanel id={automation.id} jobs={jobs} />
            </Card>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold">Open positions</h2>
            {open.length === 0 ? (
              <Empty title="Nothing open" hint="A position opens only when a resolved job clears every gate." />
            ) : (
              <div className="space-y-2">
                {open.map((position) => (
                  <PositionRow key={position.id} position={position} />
                ))}
              </div>
            )}
          </section>

          {closed.length > 0 ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold">Closed</h2>
              <div className="space-y-2">
                {closed.map((position) => (
                  <PositionRow key={position.id} position={position} />
                ))}
              </div>
            </section>
          ) : null}

          <section>
            <h2 className="mb-3 text-sm font-semibold">Activity</h2>
            <p className="mb-3 text-xs leading-relaxed text-muted">
              Refusals are recorded alongside actions. &ldquo;Why did nothing trade today&rdquo; is
              the question this log exists to answer.
            </p>
            {!events.ok || events.value.data.length === 0 ? (
              <Empty title="No activity yet" />
            ) : (
              <Card className="divide-y divide-line">
                {events.value.data.map((event) => (
                  <div key={event.id} className="px-4 py-2.5">
                    <div className="flex items-baseline gap-2 font-mono text-[11px]">
                      <span className={EVENT_TONE[event.kind] ?? "text-muted"}>{event.kind}</span>
                      {event.reason ? <span className="text-muted/70">{event.reason}</span> : null}
                      <span className="ml-auto text-muted/70">{timeAgo(event.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{event.message}</p>
                    {event.jobId ? (
                      <Link
                        href={`/jobs/${event.jobId}`}
                        className="mt-1 inline-block font-mono text-[10px] text-accent underline-offset-2 hover:underline"
                      >
                        {event.jobId}
                      </Link>
                    ) : null}
                  </div>
                ))}
              </Card>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * One position, with the verdict that opened it and a link back to the job.
 *
 * The link is the point of the whole feature: no other automated trading
 * surface can answer "why this one" with the claims, the evidence and the
 * agents that disagreed.
 */
function PositionRow({ position }: { position: PositionView }) {
  const upnl = position.pnlUsd;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-sm font-medium">{position.symbol}</p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{position.mint}</p>
        </div>
        <div className="text-right font-mono text-xs">
          <p className="tabular-nums">{usd(position.sizeUsd)}</p>
          {upnl !== null ? (
            <p className={upnl >= 0 ? "text-emerald-500" : "text-accent"}>{usd(upnl)}</p>
          ) : (
            <p className="text-muted">open</p>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
        <span>{pct(position.confidence)} confidence</span>
        <span>·</span>
        <span>{pct(position.consensus)} consensus</span>
        <span>·</span>
        <span>{position.agentsReporting} agents</span>
        {position.exitReason ? (
          <>
            <span>·</span>
            <span className="text-foreground">{position.exitReason}</span>
          </>
        ) : null}
        <span className="ml-auto">{timeAgo(position.closedAt ?? position.openedAt)}</span>
      </div>

      <Link
        href={`/jobs/${position.jobId}`}
        className="mt-2 inline-block text-[11px] text-accent underline-offset-2 hover:underline"
      >
        why this position →
      </Link>
    </Card>
  );
}

function PolicyCard({ policy }: { policy: TradePolicyView }) {
  const rows: Array<[string, string]> = [
    ["Min confidence", pct(policy.minConfidence)],
    ["Min consensus", pct(policy.minConsensus)],
    ["Min agents", String(policy.minAgents)],
    ["Unsupported claims", `≤ ${policy.maxUnsupportedClaims}`],
    ["Disagreements", `≤ ${policy.maxDisagreements}`],
    ["Size", usd(policy.sizeUsd)],
    ["Max open", String(policy.maxConcurrentPositions)],
    ["Max deployed", usd(policy.maxDeployedUsd)],
    ["Take profit", `+${policy.takeProfitPct}%`],
    ["Stop loss", `−${policy.stopLossPct}%`],
    ["Trailing", `−${policy.trailingStopPct}% after +${policy.trailingActivationPct}%`],
    ["Max hold", `${policy.maxHoldMinutes}m`],
    ["Breaker", `${policy.maxConsecutiveLosses} losses / ${usd(policy.maxDailyDrawdownUsd)}`],
    ["Mint cooldown", `${policy.mintCooldownMinutes}m`],
  ];

  return (
    <Card className="p-4">
      <p className="mb-2 text-xs font-medium text-muted">Policy</p>
      <dl className="space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3 text-[11px]">
            <dt className="text-muted">{label}</dt>
            <dd className="font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
        Every value is a ceiling checked before a position opens, never a target measured after.
      </p>
    </Card>
  );
}
