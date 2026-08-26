import { AppSidebar } from "@/components/app-sidebar";
import { WalletProvider } from "@/components/wallet";

/**
 * Shell for the product surface.
 *
 * Kept out of the root layout so the landing route at "/" renders as a bare
 * full-viewport frame with no sidebar or footer.
 *
 * The sidebar is fixed and this column is offset by its width rather than the
 * two sitting side by side in a row: a flex sibling scrolls away with the
 * page, and a job report is long enough that the nav would be gone for most
 * of the read. On small screens the offset drops and the sidebar becomes a
 * drawer, so the mobile bar it renders is a normal child of this column.
 *
 * The Privy app id is read here at request time and passed down rather than
 * inlined as `NEXT_PUBLIC_*`, which is baked in at build: one image deployed to
 * two environments would otherwise keep pointing at whichever app the build
 * machine was configured for.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  const privyAppId = process.env["PRIVY_APP_ID"]?.trim() || null;

  return (
    <WalletProvider appId={privyAppId}>
    <div className="flex min-h-dvh flex-col lg:pl-60">
      <AppSidebar />

      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 lg:px-8 lg:py-10">
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto max-w-6xl px-5 py-5 text-[11px] leading-relaxed text-muted lg:px-8">
          Reads curated Datanets and coordinates independent agents into evidence-linked
          intelligence — every claim traceable to what the runtime actually retrieved.
        </div>
      </footer>
    </div>
    </WalletProvider>
  );
}
