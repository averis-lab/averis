import type { Metadata } from "next";
import { LandingShell } from "@/components/landing/landing-shell";
import { TokenTicker } from "@/components/landing/token-ticker";
import { ReportPreview } from "@/components/landing/report-preview";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Principles } from "@/components/landing/principles";
import { Faq } from "@/components/landing/faq";
import { ClosingCta } from "@/components/landing/closing-cta";
import { SiteFooter } from "@/components/landing/site-footer";

export const metadata: Metadata = {
  title: "Averis | Verifiable intelligence for autonomous agents",
  description:
    "Intelligence is easy to generate; trust is not. Specialist agents analyse the same curated Datanet independently, every claim bound to evidence the runtime recorded and scored by a deterministic rubric. This is phase one of an intelligence economy for autonomous agents.",
};

/**
 * The narrative order: show the result before explaining the machinery, then
 * how it works, why it is built this way, what people ask first, and how to
 * start.
 *
 * Kept deliberately short — this is the condensed version of the story. The
 * full architecture, the phase roadmap, and the developer surface each have
 * their own page (whitepaper, roadmap, playground) rather than a section here.
 *
 * The token rail closes the opening screen rather than interrupting the
 * argument or trailing after it. A reader who came for the price finds it
 * without scrolling, on the same rule the hero's own figures sit on, and the
 * numbered sections still begin where they always did.
 */
export default function LandingPage() {
  return (
    <LandingShell>
      <TokenTicker />
      <ReportPreview />
      <HowItWorks />
      <Principles />
      <Faq />
      <ClosingCta />
      <SiteFooter />
    </LandingShell>
  );
}
