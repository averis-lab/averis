import type { Metadata } from "next";
import { Px402Transfer } from "@/components/px402-transfer";
import { AgentPayout } from "@/components/agent-payout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Private transfers · Averis",
  description: "Send USDC without linking the payment to the wallet it came from.",
};

/**
 * The page a person uses, not the one an operator reads.
 *
 * An earlier version carried the readiness assessment and the inbound/outbound
 * routing map as well. Both are real, and both are operator questions — is the
 * paywall on, which address does revenue land at, is the treasury share
 * payable. None of them changes what someone sending money can do, because a
 * private transfer goes wallet to wallet and never touches this gateway's
 * paywall. They are still served at `/v1/privacy/px402` and
 * `/v1/payments/routing` for whoever is actually asking them.
 */
export default function PrivacyPage() {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Private transfers</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">
          Send USDC without the payment pointing back at you. Deposit once, then spend from a
          private balance. Each payment leaves a fresh wallet, so it cannot be tied to the wallet
          you deposited from, or to anything else you have sent.
        </p>
      </header>

      <Px402Transfer />

      <AgentPayout />

      <p className="max-w-2xl text-sm leading-relaxed text-muted">
        What this hides is the link between payer and payment, from anyone reading the chain. It
        is not invisibility. The network px402 runs on, its attestor, bundler and subgraph, still
        handles the payment and can see it.
      </p>
    </div>
  );
}
