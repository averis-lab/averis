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

/* ─── What counts as a brief ─────────────────────────────────────────────── */

/*
 * A job costs real agents, real budget and real time, so the query that starts
 * one has to be a brief rather than a message.
 *
 * The old rule was `min(8)`, which is not a rule. Eight characters admits
 * "hi there", "test lol" and every insult short enough to type in anger — and
 * the network then spends a cohort, a budget and a settlement on it, and files
 * the result next to genuine work where it is indistinguishable at a glance.
 *
 * What follows is deliberately *structural*. It asks whether the text has the
 * shape of a request — length, distinct words, letters carrying the meaning —
 * and never whether the request is a good one. That line matters: a semantic
 * filter here would be unreliable in both directions, rejecting oddly-phrased
 * real briefs while waving through fluent nonsense, and it would quietly put
 * this layer in the business of deciding which questions deserve an answer.
 * Structure is checkable; merit is the cohort's job.
 *
 * So this catches the overwhelming bulk of junk — the one-liners, the mashed
 * keys, the placeholder text — and it will not catch a well-formed sentence
 * that happens to be pointless. Nothing here can.
 */

export const MIN_QUERY_CHARS = 24;
export const MIN_QUERY_WORDS = 5;
export const MIN_QUERY_DISTINCT_WORDS = 4;
export const MAX_QUERY_CHARS = 2_000;

/**
 * Words that are placeholders rather than subjects.
 *
 * Only ever counted *alongside* the other rules — a query is never rejected
 * for containing one of these, since "evaluate the sample methodology" is a
 * real brief. They are excluded when asking whether anything substantive is
 * left, which is a much weaker and much safer claim.
 */
const PLACEHOLDER_WORDS = new Set([
  "test", "testing", "tests", "asdf", "asdfgh", "qwerty",
  "dummy", "foo", "bar", "baz", "abc", "xyz", "blah", "placeholder", "todo",
  "hello", "hi", "hey", "yo", "lol", "idk", "ok", "okay",
  // The standard lorem opener, which arrives as a block or not at all.
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit",
]);

/** Grammar, not subject matter. Excluded when looking for substance. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "did",
  "do", "does", "for", "from", "has", "have", "how", "i", "if", "in", "is", "it",
  "its", "me", "my", "of", "on", "or", "should", "so", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "u", "up", "was",
  "we", "were", "what", "when", "where", "whether", "which", "who", "why",
  "will", "with", "would", "you", "your",
]);

/** Unicode-aware, so a brief written in any script is words rather than noise. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

const words = (query: string): string[] => query.toLowerCase().match(WORD) ?? [];

/**
 * The reason this query cannot start a job, or null if it can.
 *
 * A message rather than a boolean, because the requester has to be told which
 * rule they tripped: "invalid query" in a red box teaches nobody what to type
 * instead, and the next attempt is usually the same text with a word added.
 *
 * Shared by the API and the web form on purpose. The form gives the feedback
 * as it is typed and the API refuses the request; if the two ever disagreed,
 * the browser would happily submit something the gateway rejects, which reads
 * to a user as the site being broken.
 */
export function describeQueryProblem(raw: string): string | null {
  const query = raw.trim().replace(/\s+/g, " ");

  if (query.length === 0) return "Describe what intelligence you want.";
  if (query.length > MAX_QUERY_CHARS) {
    return `Keep the brief under ${MAX_QUERY_CHARS.toLocaleString("en-US")} characters.`;
  }
  if (query.length < MIN_QUERY_CHARS) {
    return `Too short to act on — write at least ${MIN_QUERY_CHARS} characters saying what should be analysed.`;
  }

  const all = words(query);
  if (all.length < MIN_QUERY_WORDS) {
    return `Too short to act on — a brief needs at least ${MIN_QUERY_WORDS} words saying what should be analysed.`;
  }
  if (new Set(all).size < MIN_QUERY_DISTINCT_WORDS) {
    return "This repeats the same few words. Describe what should be analysed and what you want decided.";
  }

  // Letters have to carry the query. A string that is mostly digits and
  // punctuation may be a valid address or figure, but on its own it is not yet
  // a question about one.
  const letters = (query.match(/\p{L}/gu) ?? []).length;
  if (letters * 2 < query.length) {
    return "This reads as symbols rather than a request. Say in words what should be analysed.";
  }

  // Something has to be left once grammar and placeholders are set aside,
  // otherwise the sentence is well-formed and about nothing.
  const substantive = new Set(
    all.filter((word) => !STOPWORDS.has(word) && !PLACEHOLDER_WORDS.has(word)),
  );
  if (substantive.size < 2) {
    return "Name what should be analysed — an asset, a corpus, a claim — and what you want decided about it.";
  }

  return null;
}

/**
 * The brief as it will be stored: trimmed, with runs of whitespace collapsed.
 *
 * Normalising at the edge is what makes the duplicate check downstream mean
 * anything — otherwise the same sentence with a stray double space is a
 * different job, and the guard is trivially defeated by accident.
 */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

export const JobQuerySchema = z
  .string()
  .transform(normalizeQuery)
  .superRefine((query, ctx) => {
    const problem = describeQueryProblem(query);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

/** What a requester submits. */
export const CreateJobSchema = z.object({
  type: z.string().min(1).default("asset-analysis"),
  query: JobQuerySchema,
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
