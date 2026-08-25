import { z } from "zod";
import { DomainTag, UnitInterval } from "./common";

export const JOB_STATUSES = [
  "CREATED",
  "QUEUED",
  "ASSIGNED",
  "RUNNING",
  "SUBMITTED",
  "VALIDATING",
  "CONSENSUS",
  "RESOLVED",
  "FAILED",
  "CANCELLED",
] as const;

export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * The lifecycle is an explicit state machine rather than a free-form status
 * column. Workers call `assertTransition` before every write, so an out-of-
 * order or duplicated queue delivery can never advance a job incorrectly.
 */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  CREATED: ["QUEUED", "CANCELLED", "FAILED"],
  QUEUED: ["ASSIGNED", "FAILED", "CANCELLED"],
  ASSIGNED: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["SUBMITTED", "FAILED", "CANCELLED"],
  SUBMITTED: ["VALIDATING", "FAILED"],
  VALIDATING: ["CONSENSUS", "FAILED"],
  CONSENSUS: ["RESOLVED", "FAILED"],
  RESOLVED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(`Illegal job transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** Terminal states never re-enter the queue. */
export function isTerminal(status: JobStatus): boolean {
  return JOB_TRANSITIONS[status].length === 0;
}

/** Known job archetypes. Free-form strings are allowed for extensibility. */
export const JOB_TYPES = [
  "asset-analysis",
  "dataset-evaluation",
  "dataset-comparison",
  "anomaly-detection",
  "market-research",
  "model-evaluation",
  "structured-research",
  "claim-validation",
] as const;

/** What a requester submits. */
export const CreateJobSchema = z.object({
  type: z.string().min(1).default("asset-analysis"),
  query: z.string().min(8, "query must describe what intelligence is wanted"),
  target: z.string().nullable().default(null),
  /** Domains an agent must cover to be eligible. Drives capability matching. */
  requiredCapabilities: z.array(DomainTag).default([]),
  /** How many agents must independently analyze this job. */
  requiredAgents: z.number().int().min(1).max(11).default(3),
  /** Total USDC available to the job. */
  budget: z.number().nonnegative().default(0),
  deadline: z
    .union([z.string(), z.date()])
    .nullable()
    .default(null)
    .transform((v) => (v ? new Date(v) : null)),
  /** Consensus below this confidence resolves as FAILED rather than shipping. */
  minimumConfidence: UnitInterval.nullable().default(null),
  /** Restrict data discovery to these upstream datanets. */
  datanetIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CreateJobInput = z.input<typeof CreateJobSchema>;
export type CreateJob = z.infer<typeof CreateJobSchema>;

export interface IntelligenceJob {
  id: string;
  type: string;
  query: string;
  target: string | null;
  requiredCapabilities: string[];
  requiredAgents: number;
  budget: number;
  deadline: Date | null;
  minimumConfidence: number | null;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
}
