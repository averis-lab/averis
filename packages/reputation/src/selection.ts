import type { AgentDescriptor } from "@averis/types";

export interface SelectionRequest {
  requiredCapabilities: string[];
  requiredAgents: number;
  /** Per-agent spend ceiling in USDC; agents pricier than this are excluded. */
  maxPricePerAgent?: number;
}

export interface SelectionResult {
  agentId: string;
  score: number;
  detail: Record<string, number | string>;
}

export interface SelectionConfig {
  weights?: {
    capabilityMatch?: number;
    domainReputation?: number;
    overallReputation?: number;
    availability?: number;
  };
  /**
   * How much the cohort is rewarded for covering *different* specializations.
   * Without this, selection converges on N near-identical agents and the
   * cohort's errors correlate — which defeats the purpose of running N of them.
   */
  diversityBonus?: number;
}

/**
 * Capability-aware agent selection.
 *
 * Explicitly *not* "take the top N by overall reputation". Two properties make
 * the difference:
 *
 *  * **Domain reputation dominates overall reputation.** A generalist with a
 *    stellar record is a worse pick for a DeFi liquidity question than a
 *    specialist with a solid record in DeFi.
 *  * **Marginal diversity is scored.** Each pick is scored against the cohort
 *    already chosen, so the second and third seats go to agents that cover
 *    domains the first pick did not.
 */
export class AgentSelector {
  private readonly weights: Required<NonNullable<SelectionConfig["weights"]>>;
  private readonly diversityBonus: number;

  constructor(config: SelectionConfig = {}) {
    this.weights = {
      capabilityMatch: config.weights?.capabilityMatch ?? 0.4,
      domainReputation: config.weights?.domainReputation ?? 0.3,
      overallReputation: config.weights?.overallReputation ?? 0.15,
      availability: config.weights?.availability ?? 0.15,
    };
    this.diversityBonus = config.diversityBonus ?? 0.2;
  }

  select(candidates: AgentDescriptor[], request: SelectionRequest): SelectionResult[] {
    const required = request.requiredCapabilities.map((c) => c.toLowerCase());

    const eligible = candidates.filter((agent) => {
      if (agent.status !== "ACTIVE") return false;
      if (agent.activeAssignments >= agent.maxConcurrent) return false;
      if (
        request.maxPricePerAgent !== undefined &&
        agent.pricePerJob > request.maxPricePerAgent
      ) {
        return false;
      }
      // With no stated requirement, every active agent is eligible.
      if (required.length === 0) return true;
      return required.some((domain) => coversDomain(agent, domain));
    });

    const chosen: SelectionResult[] = [];
    const covered = new Set<string>();
    const remaining = [...eligible];

    while (chosen.length < request.requiredAgents && remaining.length > 0) {
      let best: { index: number; score: number; detail: Record<string, number | string> } | null =
        null;

      for (let i = 0; i < remaining.length; i++) {
        const agent = remaining[i]!;
        const scored = this.score(agent, required, covered);
        if (best === null || scored.score > best.score) {
          best = { index: i, score: scored.score, detail: scored.detail };
        }
      }

      if (!best) break;
      const [agent] = remaining.splice(best.index, 1);
      if (!agent) break;

      chosen.push({ agentId: agent.id, score: round(best.score), detail: best.detail });
      for (const capability of agent.capabilities) covered.add(capability.domain.toLowerCase());
    }

    return chosen;
  }

  private score(
    agent: AgentDescriptor,
    required: string[],
    covered: Set<string>,
  ): { score: number; detail: Record<string, number | string> } {
    const capabilityMatch =
      required.length === 0
        ? 0.5
        : required.filter((domain) => coversDomain(agent, domain)).length / required.length;

    // Proficiency the agent *declared*, corrected by what it has demonstrated.
    const declared = meanDeclared(agent, required);
    const domainRep = meanDomainReputation(agent, required);
    const availability =
      agent.maxConcurrent <= 0
        ? 0
        : 1 - Math.min(1, agent.activeAssignments / agent.maxConcurrent);

    // Only domains nobody in the cohort covers yet earn the diversity bonus.
    const newDomains = agent.capabilities.filter(
      (c) => !covered.has(c.domain.toLowerCase()),
    ).length;
    const diversity =
      agent.capabilities.length === 0 ? 0 : newDomains / agent.capabilities.length;

    const base =
      capabilityMatch * this.weights.capabilityMatch +
      domainRep * this.weights.domainReputation +
      agent.reputation.overall * this.weights.overallReputation +
      availability * this.weights.availability;

    const score = base * (1 + this.diversityBonus * diversity) * (0.85 + 0.15 * declared);

    return {
      score,
      detail: {
        capabilityMatch: round(capabilityMatch),
        domainReputation: round(domainRep),
        overallReputation: round(agent.reputation.overall),
        availability: round(availability),
        diversity: round(diversity),
        declaredProficiency: round(declared),
        sampleSize: agent.reputation.sampleSize,
      },
    };
  }
}

function coversDomain(agent: AgentDescriptor, domain: string): boolean {
  return agent.capabilities.some(
    (c) => c.domain.toLowerCase() === domain || c.skill?.toLowerCase() === domain,
  );
}

function meanDeclared(agent: AgentDescriptor, required: string[]): number {
  const relevant =
    required.length === 0
      ? agent.capabilities
      : agent.capabilities.filter((c) => required.includes(c.domain.toLowerCase()));
  if (relevant.length === 0) return 0.5;
  return relevant.reduce((acc, c) => acc + c.declared, 0) / relevant.length;
}

function meanDomainReputation(agent: AgentDescriptor, required: string[]): number {
  if (required.length === 0) return agent.reputation.overall;
  const scores = required
    .map((domain) => agent.domainReputation[domain])
    .filter((v): v is NonNullable<typeof v> => v !== undefined)
    .map((v) => v.overall);
  // No record in the required domain yet: fall back to the overall score
  // rather than treating an unproven specialist as a bad one.
  if (scores.length === 0) return agent.reputation.overall;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
