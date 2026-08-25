/** One committed reservation. Written before execution, reconciled after. */
export interface SpendRecord {
  id: string;
  operatorId: string | null;
  jobId: string | null;
  agentId: string | null;
  category: "llm" | "tool" | "settlement";
  /** Amount committed up-front. */
  reserved: number;
  /** Real cost once known; null until reconciled. */
  actual: number | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface SpendWindowQuery {
  operatorId: string | null;
  since: Date;
  jobId?: string | null;
  agentId?: string | null;
  category?: SpendRecord["category"];
}

/**
 * Storage for committed spend.
 *
 * An interface rather than a concrete table so the guard can run against
 * Postgres in production and in memory in tests — the guard's correctness must
 * be testable without a database.
 */
export interface SpendLedger {
  /**
   * Sums committed spend in a window.
   *
   * Must count `actual ?? reserved`, never only settled rows: an in-flight
   * reservation is money already spoken for, and ignoring it is exactly how a
   * concurrent burst overruns a budget.
   */
  committed(query: SpendWindowQuery): Promise<number>;
  reserve(record: Omit<SpendRecord, "id" | "createdAt" | "settledAt" | "actual">): Promise<SpendRecord>;
  reconcile(id: string, actualUsd: number): Promise<void>;
  /** Releases a reservation whose work never ran. */
  release(id: string): Promise<void>;

  /**
   * Runs `fn` holding an exclusive lock on `key`, if the backing store can.
   *
   * The guard's decide-then-commit sequence must be atomic or concurrent
   * callers overrun the budget. A single-process ledger can leave this
   * undefined and rely on the guard's in-process mutex; a shared store (e.g.
   * Postgres with an advisory lock) must implement it, because several worker
   * processes hitting the same operator's budget is the normal case in
   * production, not an edge case.
   */
  withLock?<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

/** In-memory ledger for tests and single-process development. */
export class MemorySpendLedger implements SpendLedger {
  private readonly records = new Map<string, SpendRecord>();
  private counter = 0;

  async committed(query: SpendWindowQuery): Promise<number> {
    let total = 0;
    for (const record of this.records.values()) {
      if (record.createdAt < query.since) continue;
      if (query.operatorId !== undefined && record.operatorId !== query.operatorId) continue;
      if (query.jobId !== undefined && query.jobId !== null && record.jobId !== query.jobId) continue;
      if (query.agentId !== undefined && query.agentId !== null && record.agentId !== query.agentId) continue;
      if (query.category !== undefined && record.category !== query.category) continue;
      total += record.actual ?? record.reserved;
    }
    return total;
  }

  async reserve(
    record: Omit<SpendRecord, "id" | "createdAt" | "settledAt" | "actual">,
  ): Promise<SpendRecord> {
    const full: SpendRecord = {
      ...record,
      id: `spend-${++this.counter}`,
      actual: null,
      createdAt: new Date(),
      settledAt: null,
    };
    this.records.set(full.id, full);
    return full;
  }

  async reconcile(id: string, actualUsd: number): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.actual = actualUsd;
    record.settledAt = new Date();
  }

  async release(id: string): Promise<void> {
    this.records.delete(id);
  }

  all(): SpendRecord[] {
    return [...this.records.values()];
  }
}
