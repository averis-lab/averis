import Link from "next/link";
import { AverisMark } from "@/components/averis-mark";

const NAV = [
  { href: "/dashboard", label: "Jobs" },
  { href: "/datanets", label: "Datanets" },
  { href: "/agents", label: "Agents" },
  { href: "/playground", label: "Playground" },
];

/**
 * Chrome for the product surface.
 *
 * Kept out of the root layout so the landing route at "/" renders as a bare
 * full-viewport frame with no header or footer.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-5">
          <Link href="/" className="flex shrink-0 items-center gap-2">
            <AverisMark size={20} priority />
            <span className="font-mono text-sm font-semibold tracking-tight">averis</span>
            <span className="hidden text-[11px] text-muted sm:inline">
              accountability layer
            </span>
          </Link>
          <nav className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="shrink-0 rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-6xl px-5 py-5 text-[11px] leading-relaxed text-muted">
          Reads curated Datanets from Reppo over its public API and coordinates independent agents
          into evidence-linked intelligence. Reppo is external infrastructure, not part of this
          protocol.
        </div>
      </footer>
    </div>
  );
}
