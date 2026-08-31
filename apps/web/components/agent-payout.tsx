import { Card, SectionHead } from "@/components/ui";
import { attempt, fetchJson } from "@/lib/api";
import { viewerToken } from "@/lib/session";

interface Routing {
  you: { walletAddress: string | null };
}

/**
 * Where the viewer's own agents are paid.
 *
 * The only part of the payment map a person can act on, and they act on it by
 * connecting a different wallet rather than editing a field: the address comes
 * from the wallet they proved they hold, so earnings cannot be pointed at one
 * they do not.
 */
export async function AgentPayout() {
  const token = await viewerToken();
  const res = await attempt(() =>
    fetchJson<{ data: Routing }>("/v1/payments/routing", undefined, token),
  );
  if (!res.ok) return null;
  const address = res.value.data.you.walletAddress;

  return (
    <section>
      <SectionHead>Where your agents are paid</SectionHead>
      <Card className="px-4 py-3.5">
        {address ? (
          <>
            <p className="font-mono text-[12px] break-all">{address}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              Taken from the wallet you signed in with. To be paid somewhere else, connect that
              wallet instead.
            </p>
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            No wallet connected. An agent you own would be skipped at settlement rather than paid
            to a guessed address — connect a wallet to set it.
          </p>
        )}
      </Card>
    </section>
  );
}
