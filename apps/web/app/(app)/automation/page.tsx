import Link from "next/link";
import { notFound } from "next/navigation";
import { attempt, fetchJson } from "@/lib/api";
import { viewerToken } from "@/lib/session";
import { AUTOMATION_ENABLED } from "@/lib/features";
import { timeAgo } from "@/lib/format";
import { ApiDown, Card, Empty } from "@/components/ui";
import { ConnectGate, shortAddress } from "@/components/wallet";
import { DeployForm } from "@/components/automation/deploy-form";
import { usd, type AutomationView, type DriverView, type ViewerView } from "@/lib/automation";

export const dynamic = "force-dynamic";

export default async function AutomationPage() {
  // Gated: phase 5 is not reachable yet, and a route that renders while the
  // navigation says "soon" is the same as no gate at all.
  if (!AUTOMATION_ENABLED) notFound();

  const token = await viewerToken();
  const walletLogin = Boolean(process.env["PRIVY_APP_ID"]?.trim());

  // Not fetched-then-hidden: with wallet login on and nobody connected there is
  // no request to make. Reading the list with this app's shared key would show
  // one operator another operator's automations.
  if (walletLogin && !token) {
    return (
      <div className="space-y-6">
        <Header />
        <ConnectGate />
      </div>
    );
  }

  const result = await attempt(() =>
    fetchJson<{
      data: AutomationView[];
      driver: DriverView;
      priceSource: string;
      viewer: ViewerView;
    }>("/v1/automations", undefined, token),
  );

  if (!result.ok) {
    return (
      <div className="space-y-6">
        <Header />
        <ApiDown error={result.error} />
      </div>
    );
  }

  const { data, driver, priceSource, viewer } = result.value;

  return (
    <div className="space-y-8">
      <Header />

      {viewer?.walletAddress ? (
        <p className="font-mono text-[11px] text-muted">
          owned by <span className="text-foreground">{shortAddress(viewer.walletAddress)}</span>
        </p>
      ) : null}

      <RuntimeNotice driver={driver} priceSource={priceSource} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
        <section>
          <h2 className="mb-3 text-sm font-semibold">Deployed</h2>
          {data.length === 0 ? (
            <Empty
              title="Nothing deployed yet"
              hint="An automation reads finished intelligence jobs and turns the ones that clear its policy into positions. Deploy one on the right."
            />
          ) : (
            <div className="space-y-2">
              {data.map((automation) => (
                <Link key={automation.id} href={`/automation/${automation.id}`} className="block">
                  <Card className="p-4 transition-colors hover:border-accent/50">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{automation.name}</p>
                        <p className="mt-1 font-mono text-[11px] text-muted">
                          {automation.capabilities.join(" · ") || "no capability filter"}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        <Pill tone={automation.active ? "on" : "off"}>
                          {automation.active ? "STARTED" : "STOPPED"}
                        </Pill>
                        <Pill tone="mode">{automation.mode}</Pill>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
                      <span>{automation.stats.openPositions} open</span>
                      <span>·</span>
                      <span>{usd(automation.stats.deployedUsd)} deployed</span>
                      <span>·</span>
                      <span>
                        {automation.stats.closedTrades} closed
                        {automation.stats.closedTrades > 0
                          ? ` (${automation.stats.wins} up)`
                          : ""}
                      </span>
                      {automation.stats.breaker.paused ? (
                        <>
                          <span>·</span>
                          <span className="text-amber-500">breaker tripped</span>
                        </>
                      ) : null}
                      <span className="ml-auto">{timeAgo(automation.createdAt)}</span>
                    </div>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Deploy an automation</h2>
          <Card className="p-5">
            <DeployForm />
          </Card>
        </section>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2.5">
        <h1 className="text-xl font-semibold tracking-tight">Automation</h1>
        <span className="rounded border border-accent/30 bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-accent uppercase">
          Preview
        </span>
      </div>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        <span className="text-foreground">Coming soon — phase 5.</span> Bounded autonomy is the
        last phase on the roadmap, and this is its first surface: paper mode only, no custody, no
        live driver. It runs today so the policy can be exercised against real resolved jobs, not
        because the protocol claims this capability yet.
      </p>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">
        An automation is a consumer of intelligence, not part of the protocol. It reads jobs the
        protocol resolved, applies a policy you set, and opens a position only when the cohort
        cleared every gate — so every position traces back to the claims and evidence behind it.
      </p>
    </div>
  );
}

/**
 * States plainly what this installation can and cannot do.
 *
 * Both facts change what the page means. With no execution driver nothing ever
 * opens; with no price source nothing ever marks or exits. Discovering either
 * from an empty positions table would read as "the policy is too strict".
 */
function RuntimeNotice({ driver, priceSource }: { driver: DriverView; priceSource: string }) {
  const noDriver = driver.name === "none";
  const noPrices = priceSource === "none";
  if (!noDriver && !noPrices) {
    return (
      <Card className="p-4">
        <p className="font-mono text-[11px] text-muted">
          driver <span className="text-foreground">{driver.name}</span> · prices{" "}
          <span className="text-foreground">{priceSource}</span> · live execution not implemented
        </p>
      </Card>
    );
  }

  return (
    <Card className="border-amber-500/30 bg-amber-500/5 p-5">
      <p className="text-sm font-medium text-amber-500">
        {noDriver ? "No execution driver is configured" : "No price source is configured"}
      </p>
      <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-muted">
        {noDriver ? (
          <li>
            Set <Cmd>EXECUTION_DRIVER=paper</Cmd> to record simulated fills. The default refuses to
            act rather than booking positions that do not exist.
          </li>
        ) : null}
        {noPrices ? (
          <li>
            Set <Cmd>EXECUTION_PRICE_URL</Cmd> to a quote endpoint you have verified. Without one,
            nothing opens and no position is ever marked — a mark nobody observed would make every
            number below fiction.
          </li>
        ) : null}
        <li>
          There is no live driver in this repository, so an automation cannot spend real money
          whatever else is set.
        </li>
      </ul>
    </Card>
  );
}

function Pill({ children, tone }: { children: React.ReactNode; tone: "on" | "off" | "mode" }) {
  const style =
    tone === "on"
      ? "border-emerald-500/40 text-emerald-500"
      : tone === "mode"
        ? "border-accent/40 text-accent"
        : "border-line text-muted";
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium tracking-wide ${style}`}
    >
      {children}
    </span>
  );
}

function Cmd({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-line px-1 py-0.5 font-mono text-[11px]">{children}</code>;
}
