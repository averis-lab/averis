import {
  BudgetExceededError,
  DEFAULT_POLICY,
  type BudgetDecision,
  type BudgetPolicy,
  type DenialReason,
  type SpendRequest,
} from "./policy";
import type { SpendLedger, SpendRecord } from "./ledger";
import { KeyedMutex } from "./mutex";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export interface Reservation {
  record: SpendRecord;
  decision: BudgetDecision;
  /** Records the real cost. Always call this, including on failure. */
  reconcile(actualUsd: number): Promise<void>;
  /** Returns the committed amount when the work never ran. */
  release(): Promise<void>;
}

/**
 * Enforces spend limits *before* work is executed.
 *
 * The ordering is the whole point. `check` alone is not a guarantee — between
 * checking and spending, another worker can commit the same headroom. So the
 * only public path that leads to execution is `reserve`, which writes the
 * commitment to the ledger as part of the decision. Callers cannot execute
 * first and account later, because nothing hands them a reservation until the
 * money is already accounted for.
 */
export class BudgetGuard {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly ledger: SpendLedger,
    private readonly policy: BudgetPolicy = DEFAULT_POLICY,
  ) {}

  /**
   * Evaluates every limit without committing. Use for previews and planning;
   * never as the gate immediately before spending — use `reserve` for that.
   */
  async check(request: SpendRequest, now: Date = new Date()): Promise<BudgetDecision> {
    if (!Number.isFinite(request.estimatedUsd) || request.estimatedUsd < 0) {
      return {
        allowed: false,
        reason: "INVALID_ESTIMATE",
        message: `Estimated cost must be a non-negative finite number, received ${request.estimatedUsd}`,
        remaining: 0,
        checks: [],
      };
    }

    const dayStart = new Date(now.getTime() - DAY_MS);
    const weekStart = new Date(now.getTime() - WEEK_MS);

    const [daily, weekly, perJob, perAgent] = await Promise.all([
      this.ledger.committed({ operatorId: request.operatorId, since: dayStart }),
      this.ledger.committed({ operatorId: request.operatorId, since: weekStart }),
      request.jobId
        ? this.ledger.committed({
            operatorId: request.operatorId,
            jobId: request.jobId,
            since: new Date(0),
          })
        : Promise.resolve(0),
      request.agentId && request.jobId
        ? this.ledger.committed({
            operatorId: request.operatorId,
            jobId: request.jobId,
            agentId: request.agentId,
            since: new Date(0),
          })
        : Promise.resolve(0),
    ]);

    // Inference and tool spend may not eat into the settlement reserve; a
    // settlement request itself may use the full daily budget.
    const dailyCeiling =
      request.category === "settlement"
        ? this.policy.daily
        : Math.max(0, this.policy.daily - this.policy.transactionReserve);

    const checks: BudgetDecision["checks"] = [
      {
        limit: request.category === "settlement" ? "DAILY_LIMIT" : "TRANSACTION_RESERVE",
        ceiling: dailyCeiling,
        committed: daily,
        wouldBe: daily + request.estimatedUsd,
      },
      {
        limit: "WEEKLY_LIMIT",
        ceiling: this.policy.weekly,
        committed: weekly,
        wouldBe: weekly + request.estimatedUsd,
      },
    ];

    if (request.jobId) {
      checks.push({
        limit: "PER_JOB_LIMIT",
        ceiling: this.policy.perJob,
        committed: perJob,
        wouldBe: perJob + request.estimatedUsd,
      });
    }
    if (request.agentId && request.jobId) {
      checks.push({
        limit: "PER_AGENT_LIMIT",
        ceiling: this.policy.perAgent,
        committed: perAgent,
        wouldBe: perAgent + request.estimatedUsd,
      });
    }

    const breached = checks.find((c) => c.wouldBe > c.ceiling + 1e-9);
    const remaining = Math.min(...checks.map((c) => c.ceiling - c.committed));

    if (breached) {
      const reason: DenialReason =
        breached.limit === "TRANSACTION_RESERVE" && daily + request.estimatedUsd > this.policy.daily
          ? "DAILY_LIMIT"
          : breached.limit;

      return {
        allowed: false,
        reason,
        message: `${reason} would be exceeded: committed ${breached.committed.toFixed(4)} + estimated ${request.estimatedUsd.toFixed(4)} > ceiling ${breached.ceiling.toFixed(4)} ${this.policy.currency}`,
        remaining: Math.max(0, remaining),
        checks,
      };
    }

    return { allowed: true, remaining: Math.max(0, remaining), checks };
  }

  /**
   * Checks the limits and, if they pass, commits the estimate to the ledger in
   * the same call. This is the only sanctioned path to executing paid work.
   *
   * Throws `BudgetExceededError` on denial — callers must handle the failure
   * explicitly rather than being able to ignore a falsy return value.
   */
  async reserve(request: SpendRequest, now: Date = new Date()): Promise<Reservation> {
    // Decide and commit atomically. Checking outside the lock would let
    // concurrent callers each observe the same headroom and all spend it.
    const key = `operator:${request.operatorId ?? "global"}`;
    const run = <T>(fn: () => Promise<T>): Promise<T> =>
      this.ledger.withLock ? this.ledger.withLock(key, fn) : this.mutex.run(key, fn);

    return run(async () => this.reserveLocked(request, now));
  }

  private async reserveLocked(request: SpendRequest, now: Date): Promise<Reservation> {
    const decision = await this.check(request, now);
    if (!decision.allowed) throw new BudgetExceededError(decision);

    const record = await this.ledger.reserve({
      operatorId: request.operatorId,
      jobId: request.jobId,
      agentId: request.agentId ?? null,
      category: request.category,
      reserved: request.estimatedUsd,
    });

    return {
      record,
      decision,
      reconcile: (actualUsd: number) => this.ledger.reconcile(record.id, actualUsd),
      release: () => this.ledger.release(record.id),
    };
  }

  /**
   * Runs `work` only if it fits the budget, reconciling the real cost
   * afterwards — including when the work throws.
   *
   * This is the ergonomic path: it makes "execute then account" impossible to
   * write by accident, because the estimate is committed before `work` is
   * called and the actual cost is always recorded.
   */
  async withBudget<T>(
    request: SpendRequest,
    work: () => Promise<{ result: T; actualUsd: number }>,
    now: Date = new Date(),
  ): Promise<T> {
    const reservation = await this.reserve(request, now);
    try {
      const { result, actualUsd } = await work();
      await reservation.reconcile(actualUsd);
      return result;
    } catch (error) {
      // Failed work still consumed tokens; keep the estimate rather than
      // releasing it, so a crash-looping agent cannot spend without limit.
      await reservation.reconcile(request.estimatedUsd);
      throw error;
    }
  }

  get limits(): BudgetPolicy {
    return this.policy;
  }
}
