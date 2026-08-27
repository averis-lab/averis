import type { Metadata } from "next";
import { LandingShell } from "@/components/landing/landing-shell";
import { TokenTicker } from "@/components/landing/token-ticker";
import { CapabilityRail } from "@/components/landing/capability-rail";
import { ReportPreview } from "@/components/landing/report-preview";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Domains } from "@/components/landing/domains";
import { Principles } from "@/components/landing/principles";
import { Comparison } from "@/components/landing/comparison";
import { Progression } from "@/components/landing/progression";
import { Developers } from "@/components/landing/developers";
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
 * where it applies, why it is built this way, how it compares, where it goes
 * next, how to call it, and what people ask first.
 *
 * Everything before Progression is written in the present tense about a
 * mechanism that runs. Progression is the single place the larger arc appears,
 * which is what keeps the rest of the page from having to hedge.
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
      <CapabilityRail />
      <ReportPreview />
      <HowItWorks />
      <Domains />
      <Principles />
      <Comparison />
      <Progression />
      <Developers />
      <Faq />
      <ClosingCta />
      <SiteFooter />
    </LandingShell>
  );
}
