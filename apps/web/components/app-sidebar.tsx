"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AverisMark } from "@/components/averis-mark";
import { WalletButton } from "@/components/wallet";
import { AUTOMATION_ENABLED } from "@/lib/features";

/**
 * Chrome for the product surface.
 *
 * A sidebar rather than a top bar because the product's sections are a fixed,
 * shallow set that stays visible while you read a long job report — a job
 * detail page scrolls far enough that a sticky top row is the only thing left
 * on screen to navigate from.
 *
 * The whole thing is one client component: the active route and the mobile
 * drawer are the only interactive parts, and splitting them would push
 * `usePathname` into two components that have to agree about the same match
 * rules.
 */

interface NavItem {
  href: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactElement;
  /**
   * Extra path prefixes that should light this item up. A job detail lives at
   * `/jobs/:id`, not under `/dashboard`, so href matching alone would leave
   * the nav with nothing selected on the page people spend the most time on.
   */
  also?: string[];
  /**
   * A section that exists but is not reachable yet. It stays in the navigation
   * — removing it entirely would hide that the work is under way — but renders
   * as an inert row carrying its phase, not as a link to a 404.
   */
  soon?: boolean;
}

const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Protocol",
    items: [
      { href: "/dashboard", label: "Jobs", icon: JobsIcon, also: ["/jobs"] },
      { href: "/agents", label: "Agents", icon: AgentsIcon },
      { href: "/datanets", label: "Datanets", icon: DatanetsIcon },
      { href: "/privacy", label: "Private send", icon: PrivacyIcon },
    ],
  },
  {
    label: "Automation",
    items: [
      { href: "/automation", label: "Agents", icon: AutomationIcon, soon: !AUTOMATION_ENABLED },
    ],
  },
  {
    label: "Develop",
    items: [{ href: "/playground", label: "Playground", icon: PlaygroundIcon }],
  },
];

const DOCS = [
  { href: "/whitepaper", label: "Whitepaper" },
  { href: "/roadmap", label: "Roadmap" },
];

function isActive(pathname: string, item: NavItem): boolean {
  const prefixes = [item.href, ...(item.also ?? [])];
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function AppSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  /**
   * Every link dismisses the drawer from the click that caused the
   * navigation, rather than from an effect watching the pathname: that effect
   * sets state for a panel already on its way out, and never fires at all on
   * a tap targeting the route you are already on.
   */
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // The panel scrolls; the page behind it should not scroll with it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-background/85 px-4 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation"
          aria-expanded={open}
          className="-ml-1.5 rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-foreground"
        >
          <MenuIcon />
        </button>
        <Brand onNavigate={close} />
      </div>

      {open ? (
        <div
          onClick={close}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-line bg-background transition-transform duration-200 ease-out lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
          <Brand onNavigate={close} />
          <button
            type="button"
            onClick={close}
            aria-label="Close navigation"
            className="-mr-1.5 rounded-md p-1.5 text-muted transition-colors hover:bg-surface hover:text-foreground lg:hidden"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
          {GROUPS.map((group) => (
            <div key={group.label}>
              <p className="px-2.5 pb-2 text-[10px] font-medium tracking-[0.12em] text-muted/70 uppercase">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isActive(pathname, item);
                  const Icon = item.icon;

                  /*
                   * Gated: a row, not a link. `aria-disabled` on an anchor
                   * still leaves it focusable and followable, so there is no
                   * anchor at all — the pill is what says why.
                   */
                  if (item.soon) {
                    return (
                      <li key={item.href}>
                        <div
                          className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted/50"
                          title="Coming soon — roadmap phase 5"
                        >
                          <Icon className="text-muted/50" />
                          {item.label}
                          <span className="ml-auto rounded border border-line px-1.5 py-0.5 font-mono text-[9px] tracking-wide text-muted/70 uppercase">
                            Soon
                          </span>
                        </div>
                      </li>
                    );
                  }

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={close}
                        aria-current={active ? "page" : undefined}
                        className={`relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors ${
                          active
                            ? "bg-surface font-medium text-foreground"
                            : "text-muted hover:bg-surface/60 hover:text-foreground"
                        }`}
                      >
                        {/* The accent rail is what makes the selected row
                            readable at a glance; the tint alone is only a few
                            percent off the page background. */}
                        <span
                          aria-hidden
                          className={`absolute top-1/2 left-0 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent transition-opacity ${
                            active ? "opacity-100" : "opacity-0"
                          }`}
                        />
                        <Icon className={active ? "text-accent" : "text-muted"} />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 space-y-2 border-t border-line px-3 py-3">
          <WalletButton />
          <ul className="space-y-0.5">
            {DOCS.map((doc) => (
              <li key={doc.href}>
                <Link
                  href={doc.href}
                  onClick={close}
                  className="block rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-surface/60 hover:text-foreground"
                >
                  {doc.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>
  );
}

function Brand({ onNavigate }: { onNavigate: () => void }) {
  return (
    <Link href="/" onClick={onNavigate} className="flex min-w-0 items-center gap-2">
      <AverisMark size={20} priority />
      <span className="font-mono text-sm font-semibold tracking-tight">averis</span>
    </Link>
  );
}

/* Icons are hand-rolled rather than pulled from a set: four 16px glyphs do not
   justify a dependency, and these inherit currentColor so the active state is
   a single class on the parent. */

function Glyph({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`shrink-0 transition-colors ${className}`}
    >
      {children}
    </svg>
  );
}

function JobsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <rect x="2.5" y="3" width="11" height="4" rx="1.25" />
      <rect x="2.5" y="9" width="11" height="4" rx="1.25" />
    </Glyph>
  );
}

/** Three nodes and the edges between them — a cohort, not a single worker. */
function AgentsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <circle cx="8" cy="3.6" r="1.7" />
      <circle cx="3.4" cy="12" r="1.7" />
      <circle cx="12.6" cy="12" r="1.7" />
      <path d="M6.8 5.1 4.6 10.5M9.2 5.1l2.2 5.4M5.1 12h5.8" />
    </Glyph>
  );
}

function DatanetsIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4" />
      <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
    </Glyph>
  );
}

/** A rule line with a position above and below it — a gate, not a rocket. */
function AutomationIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M2.5 8h11" />
      <circle cx="5.5" cy="4.5" r="1.5" />
      <circle cx="10.5" cy="11.5" r="1.5" />
    </Glyph>
  );
}

/** A shield: the payment is public, what it says about the payer is not. */
function PrivacyIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M8 2.2 13 4v4c0 3-2.1 5-5 5.8C5.1 13 3 11 3 8V4z" />
      <path d="M6.2 8.1 7.4 9.3l2.4-2.6" />
    </Glyph>
  );
}

function PlaygroundIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="m5.4 7 1.7 1.7-1.7 1.7M9.4 10.4h2.3" />
    </Glyph>
  );
}

function MenuIcon() {
  return (
    <Glyph>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
    </Glyph>
  );
}

function CloseIcon() {
  return (
    <Glyph>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Glyph>
  );
}
