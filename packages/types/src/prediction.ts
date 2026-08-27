import { z } from "zod";
import { UnitInterval } from "./common";

export const PredictionOutcomeSchema = z.enum([
  "PENDING",
  "TRUE",
  "FALSE",
  "UNRESOLVABLE",
  "VOID",
]);
export type PredictionOutcome = z.infer<typeof PredictionOutcomeSchema>;

export interface PendingPrediction {
  id: string;
  claimId: string;
  agentId: string;
  statement: string;
  confidence: number;
  criteria: {
    metric: string;
    operator: "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
    threshold: number | string;
    source: string;
  };
  deadline: Date;
}

/**
 * An oracle turns resolution criteria into an observed value. Resolvers are
 * pluggable so the protocol can add price feeds, on-chain readers or manual
 * adjudication without changing the resolution worker.
 */
export interface ResolutionOracle {
  readonly name: string;
  /** Whether this oracle can answer for the given source locator. */
  supports(source: string): boolean;
  /**
   * Returns null when the value could not be observed.
   *
   * `now` is the sweep's clock, passed in rather than read from the wall so an
   * oracle deciding whether it has arrived too late to observe measures that
   * against the same instant that selected the prediction as due.
   */
  observe(prediction: PendingPrediction, now?: Date): Promise<number | string | null>;
}

/**
 * The source could not be reached, as distinct from having no answer.
 *
 * These two are worth separating because their consequences differ and only
 * one of them is reversible. A prediction nothing can ever settle — no oracle,
 * an unobservable metric, a deadline long past — is honestly UNRESOLVABLE, and
 * that is terminal. A prediction whose oracle merely timed out is not: burning
 * it removes a real observation from an agent's accuracy for no reason other
 * than a dropped connection, and the row can never come back to be scored.
 *
 * An oracle throws this to leave the prediction PENDING for the next sweep.
 * Retrying is bounded without needing a counter: once the deadline is far
 * enough behind that a spot reading no longer describes it, the oracle stops
 * throwing and starts declining, and the prediction settles as UNRESOLVABLE
 * for the true reason rather than the transient one.
 */
export class OracleUnavailableError extends Error {
  constructor(readonly oracle: string, message: string) {
    super(`${oracle} could not be reached: ${message}`);
    this.name = "OracleUnavailableError";
  }
}

/**
 * Brier score for a binary outcome — the calibration primitive.
 * 0 is perfect, 0.25 is a coin flip stated at 50%, 1 is maximally wrong.
 */
export function brierScore(confidence: number, outcomeWasTrue: boolean): number {
  const actual = outcomeWasTrue ? 1 : 0;
  const diff = confidence - actual;
  return diff * diff;
}

export function evaluateCriteria(
  operator: PendingPrediction["criteria"]["operator"],
  observed: number | string,
  threshold: number | string,
): boolean {
  if (typeof observed === "number" && typeof threshold === "number") {
    switch (operator) {
      case "gt":
        return observed > threshold;
      case "gte":
        return observed >= threshold;
      case "lt":
        return observed < threshold;
      case "lte":
        return observed <= threshold;
      case "eq":
        return observed === threshold;
      case "neq":
        return observed !== threshold;
    }
  }
  const a = String(observed).trim().toLowerCase();
  const b = String(threshold).trim().toLowerCase();
  switch (operator) {
    case "eq":
      return a === b;
    case "neq":
      return a !== b;
    default:
      throw new Error(`Operator "${operator}" requires numeric values`);
  }
}

export const PredictionConfidence = UnitInterval;
