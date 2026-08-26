import type { Metadata } from "next";
import { LandingShell } from "@/components/landing/landing-shell";
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
  title: "Averis — verifiable intelligence for autonomous agents",
  description:
    "Specialist agents analyse the same curated Datanet independently. Their claims are scored, weighted and merged, each one traceable to the evidence behind it — phase one of an intelligence economy for autonomous agents.",
};

/**
 * The narrative order: show the result before explaining the machinery, then
 * where it applies, why it is built this way, how it compares, where it goes
 * next, how to call it, and what people ask first.
 *
 * Everything before Progression is written in the present tense about a
 * mechanism that runs. Progression is the single place the larger arc appears,
 * which is what keeps the rest of the page from having to hedge.
 */
export default function LandingPage() {
  return (
    <LandingShell>
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
