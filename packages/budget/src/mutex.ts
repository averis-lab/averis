/**
 * Serializes async sections by key.
 *
 * The budget guard reads the ledger to decide, then writes to commit. Run
 * concurrently, ten callers all read the same headroom, all pass, and all
 * commit — overrunning the budget tenfold. That is not hypothetical: it is
 * exactly what a worker pool does when a job fans out to several agents at
 * once.
 *
 * This closes the window within a process. Across processes the ledger itself
 * must provide the guarantee — see `SpendLedger.withLock`.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();

    // Chain onto the previous holder regardless of how it settled, so one
    // caller's failure cannot wedge the key for everyone behind it.
    const result = previous.then(fn, fn);

    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);

    // Release the key once nothing else has queued behind this holder.
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });

    return result;
  }

  /** Keys with work in flight. Exposed so tests can assert there is no leak. */
  get size(): number {
    return this.tails.size;
  }
}
