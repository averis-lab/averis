import type { Datanet, DataItem } from "@averis/types";
import type { ReppoPod, ReppoSubnet } from "./schemas";

export const REPPO_SOURCE = "reppo";

/**
 * Reppo curation is stake-weighted vote *volume*, not a count of votes. A pod
 * with 3 500 volume and one with 500 000 volume can both show a 100% approval
 * rate, but they are not equally trustworthy.
 *
 * So quality shrinks the raw approval rate toward 0.5 in proportion to how
 * little volume backs it:
 *
 *     quality = 0.5 + (approval - 0.5) * confidence
 *     confidence = log10(1 + volume) / log10(1 + saturation)
 *
 * A brand-new pod with no votes lands on 0.5 (no information), and a heavily
 * voted pod converges on its true approval rate. The log makes the curve
 * forgiving in the low range where most fresh data lives.
 */
export function curationQuality(
  upVolume: number,
  downVolume: number,
  saturation: number,
): { approvalRate: number; quality: number } {
  const up = Math.max(0, upVolume || 0);
  const down = Math.max(0, downVolume || 0);
  const total = up + down;
  if (total <= 0) return { approvalRate: 0.5, quality: 0.5 };

  const approvalRate = up / total;
  const confidence = Math.min(1, Math.log10(1 + total) / Math.log10(1 + saturation));
  const quality = 0.5 + (approvalRate - 0.5) * confidence;
  return { approvalRate, quality: clamp01(quality) };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Volume at which a datanet's approval rate is taken at face value. */
export const DATANET_SATURATION = 10_000_000;
/** Volume at which a pod's approval rate is taken at face value. */
export const POD_SATURATION = 100_000;

/**
 * Domain inference is a keyword heuristic over the datanet's own text. It
 * exists so capability-aware agent selection has something to match on;
 * datanet owners do not publish machine-readable domain tags.
 */
const DOMAIN_LEXICON: Record<string, readonly string[]> = {
  crypto: ["crypto", "token", "coin", "onchain", "on-chain", "blockchain", "web3", "wallet"],
  defi: ["defi", "liquidity", "amm", "lending", "yield", "staking", "swap", "tvl", "perp"],
  solana: ["solana", "spl", "jupiter", "raydium"],
  ethereum: ["ethereum", "evm", "erc-20", "erc20", "base", "arbitrum", "l2"],
  security: ["security", "exploit", "vulnerability", "audit", "hack", "rug", "scam", "phishing"],
  markets: ["market", "trading", "price", "volatility", "forecast", "prediction", "macro"],
  ai: ["ai", "llm", "model", "training", "inference", "benchmark", "eval", "agent"],
  robotics: ["robot", "robotics", "teleop", "manipulation", "embodied"],
  geopolitics: ["geopolit", "sanction", "conflict", "war", "election", "diplomat", "misinfo"],
  research: ["research", "paper", "study", "analysis", "report", "dataset"],
  rwa: ["rwa", "real-world asset", "tokenized", "treasury", "commodity"],
};

export function inferDomains(...texts: Array<string | null | undefined>): string[] {
  const haystack = texts.filter(Boolean).join(" ").toLowerCase();
  const found = new Set<string>();
  for (const [domain, keywords] of Object.entries(DOMAIN_LEXICON)) {
    if (keywords.some((k) => haystack.includes(k))) found.add(domain);
  }
  // Never return an empty tag set — an untagged datanet would be invisible
  // to capability matching, which is worse than being broadly tagged.
  if (found.size === 0) found.add("general");
  return [...found];
}

/**
 * Longest rubric text carried through.
 *
 * Generous enough for the real ones (the largest observed is ~900 characters)
 * and bounded so a datanet cannot push an unbounded wall of text into every
 * agent prompt that touches it.
 */
const RUBRIC_MAX_CHARS = 1_500;

/**
 * Normalizes rubric prose without attempting to sanitise its meaning.
 *
 * Only shape is corrected here: control characters removed, runaway blank
 * lines collapsed, length capped. Trying to strip "injection attempts" from
 * free text is unreliable and breeds false confidence; the real defence is
 * where this text is placed — quoted and labelled inside a user turn, never
 * spliced into a system prompt. See `buildUserPrompt`.
 */
function normalizeRubricText(raw: string | null | undefined): string {
  if (!raw) return "";

  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned.length > RUBRIC_MAX_CHARS
    ? `${cleaned.slice(0, RUBRIC_MAX_CHARS - 1)}…`
    : cleaned;
}

export function normalizeSubnet(subnet: ReppoSubnet): Datanet {
  const { approvalRate } = curationQuality(
    subnet.upVoteVolume ?? 0,
    subnet.downVoteVolume ?? 0,
    DATANET_SATURATION,
  );
  return {
    id: subnet.id,
    source: REPPO_SOURCE,
    name: subnet.subnetName || subnet.id,
    description: subnet.subnetDescription ?? "",
    domains: inferDomains(subnet.subnetName, subnet.subnetDescription),
    curation: {
      upVoteVolume: subnet.upVoteVolume ?? 0,
      downVoteVolume: subnet.downVoteVolume ?? 0,
      approvalRate,
      status: subnet.status ?? "UNKNOWN",
    },
    rubric: {
      publisherSpec: normalizeRubricText(subnet.onboardingPublishers),
      voterRubric: normalizeRubricText(subnet.onboardingVoters),
    },
    accessFee: subnet.accessFeeREPPO ?? 0,
    thumbnailUrl: subnet.thumbnailUrl ?? null,
    raw: subnet,
  };
}

export function normalizePod(pod: ReppoPod): DataItem {
  const up = pod.cumulativeUpVotesVolume ?? 0;
  const down = pod.cumulativeDownVotesVolume ?? 0;
  const { approvalRate, quality } = curationQuality(up, down, POD_SATURATION);

  // A banned pod carries zero evidentiary weight regardless of its votes.
  const qualityScore = pod.banned ? 0 : quality;

  return {
    id: pod.id,
    source: REPPO_SOURCE,
    datanetId: pod.privateSubnetId ?? null,
    title: pod.name || pod.id,
    content: pod.description ?? "",
    url: pod.url || null,
    qualityScore,
    curation: {
      upVotes: up,
      downVotes: down,
      approvalRate,
      epoch: pod.podValidityEpoch ?? null,
    },
    author: pod.creator?.username ?? null,
    publishedAt: pod.createdAt ? new Date(pod.createdAt) : null,
    raw: pod,
  };
}

/**
 * Canonical provenance locator. Kept stable even if the upstream URL rots,
 * so evidence recorded today can still be traced back years from now.
 */
export function reppoUri(kind: "pod" | "datanet", id: string): string {
  return `reppo://${kind}/${id}`;
}
