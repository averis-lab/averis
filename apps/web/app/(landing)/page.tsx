import type { Metadata } from "next";
import { LandingShell } from "@/components/landing/landing-shell";
import { CapabilityRail } from "@/components/landing/capability-rail";
import { ReportPreview } from "@/components/landing/report-preview";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Domains } from "@/components/landing/domains";
import { Principles } from "@/components/landing/principles";
import { Comparison } from "@/components/landing/comparison";
import { Developers } from "@/components/landing/developers";
import { Faq } from "@/components/landing/faq";
import { ClosingCta } from "@/components/landing/closing-cta";
import { SiteFooter } from "@/components/landing/site-footer";

export const metadata: Metadata = {
  title: "Averis — the accountability layer between evidence and decisions",
  description:
    "Specialist agents analyse the same curated Reppo Datanet independently. Their claims are scored, weighted and merged, each one traceable to the evidence behind it.",
};

/**
 * The narrative order: show the result before explaining the machinery, then
 * where it applies, why it is built this way, how it compares, how to call it,
 * and what people ask first.
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
      <Developers />
      <Faq />
      <ClosingCta />
      <SiteFooter />
    </LandingShell>
  );
}
