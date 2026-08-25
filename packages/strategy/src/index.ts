import { z } from "zod";

/** Parses a human cadence like "30m", "2h", "45s" into milliseconds. */
export function parseCadence(input: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(input.trim());
  if (!match) throw new Error(`Invalid cadence "${input}". Use forms like 30s, 15m, 2h, 1d.`);
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const scale = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return value * scale;
}

export const StrategyConfigSchema = z.object({
  /** Domains this operator is willing to work in. Empty means any. */
  domains: z.array(z.string().toLowerCase()).default([]),
  /** Skip jobs paying less than this, in USDC. */
  minReward: z.number().nonnegative().default(0),
  /**
   * Skip jobs demanding more confidence than the operator can credibly reach.
   * Taking a job that will fail its own threshold burns budget for nothing.
   */
  maxRequiredConfidence: z.number().min(0).max(1).default(1),
  /** Hard ceiling on jobs in flight at once. */
  maxConcurrentJobs: z.number().int().positive().default(5),
  /** How often the operator looks for work. */
  cadence: z.string().default("30m"),
  /** Skip a job whose deadline is closer than this many milliseconds. */
  minTimeToDeadlineMs: z.number().int().nonnegative().default(60_000),
  /** Job types to accept. Empty means any. */
  jobTypes: z.array(z.string()).default([]),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;
export type StrategyConfigInput = z.input<typeof StrategyConfigSchema>;

/** The subset of a job the strategy needs in order to decide. */
export interface CandidateJob {
  id: string;
  type: string;
  requiredCapabilities: string[];
  budget: number;
  minimumConfidence: number | null;
  deadline: Date | null;
  status: string;
}

export type SkipReason =
  | "DOMAIN_MISMATCH"
  | "JOB_TYPE_MISMATCH"
  | "REWARD_TOO_LOW"
  | "CONFIDENCE_TOO_HIGH"
  | "DEADLINE_TOO_CLOSE"
  | "AT_CAPACITY";

export interface StrategyDecision {
  jobId: string;
  accept: boolean;
  reason?: SkipReason;
  /** Higher is more attractive; used to order accepted jobs. */
  score: number;
}

/**
 * Decides which jobs an operator takes.
 *
 * Separate from the budget guard on purpose: strategy answers "is this job
 * worth doing", the budget guard answers "can this be afforded right now".
 * Conflating them would let an operator with spare budget take work it should
 * decline, and an operator with good strategy overspend.
 */
export class StrategyEngine {
  constructor(private readonly config: StrategyConfig) {}

  /** Filters and ranks candidates, respecting the concurrency ceiling. */
  select(candidates: CandidateJob[], inFlight: number, now: Date = new Date()): StrategyDecision[] {
    const capacity = Math.max(0, this.config.maxConcurrentJobs - inFlight);

    const decisions = candidates.map((job) => this.evaluate(job, now));
    const accepted = decisions
      .filter((d) => d.accept)
      .sort((a, b) => b.score - a.score);

    // Anything beyond capacity is reported as skipped rather than dropped, so
    // the operator log explains why a viable job was not taken.
    const taken = new Set(accepted.slice(0, capacity).map((d) => d.jobId));

    return decisions.map((decision) =>
      decision.accept && !taken.has(decision.jobId)
        ? { ...decision, accept: false, reason: "AT_CAPACITY" as const }
        : decision,
    );
  }

  evaluate(job: CandidateJob, now: Date = new Date()): StrategyDecision {
    const skip = (reason: SkipReason): StrategyDecision => ({
      jobId: job.id,
      accept: false,
      reason,
      score: 0,
    });

    if (this.config.jobTypes.length > 0 && !this.config.jobTypes.includes(job.type)) {
      return skip("JOB_TYPE_MISMATCH");
    }

    if (this.config.domains.length > 0) {
      const wanted = new Set(this.config.domains);
      const overlaps =
        job.requiredCapabilities.length === 0 ||
        job.requiredCapabilities.some((c) => wanted.has(c.toLowerCase()));
      if (!overlaps) return skip("DOMAIN_MISMATCH");
    }

    if (job.budget < this.config.minReward) return skip("REWARD_TOO_LOW");

    if (
      job.minimumConfidence !== null &&
      job.minimumConfidence > this.config.maxRequiredConfidence
    ) {
      return skip("CONFIDENCE_TOO_HIGH");
    }

    if (job.deadline) {
      const remaining = job.deadline.getTime() - now.getTime();
      if (remaining < this.config.minTimeToDeadlineMs) return skip("DEADLINE_TOO_CLOSE");
    }

    // Prefer well-paid work with room to run: reward dominates, urgency breaks
    // ties toward jobs that would otherwise expire.
    const matchedDomains =
      this.config.domains.length === 0
        ? 1
        : job.requiredCapabilities.filter((c) => this.config.domains.includes(c.toLowerCase()))
            .length / Math.max(1, job.requiredCapabilities.length);

    const urgency = job.deadline
      ? Math.min(1, 3_600_000 / Math.max(1, job.deadline.getTime() - now.getTime()))
      : 0.2;

    return {
      jobId: job.id,
      accept: true,
      score: job.budget * 0.6 + matchedDomains * 0.3 + urgency * 0.1,
    };
  }

  get cadenceMs(): number {
    return parseCadence(this.config.cadence);
  }

  get limits(): StrategyConfig {
    return this.config;
  }
}
