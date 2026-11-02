/**
 * The completions sent to a session but not yet shown by it.
 *
 * A custom message has no delivery receipt: the session emitting it is the only proof it arrived, and
 * an abort clears the queue it waits in without a trace. Owning the message here is what lets a later
 * settle re-send it instead of losing the job's result.
 */
export class WakeLedger<T> {
  private readonly owed = new Map<string, T>();
  private readonly redelivered = new Set<string>();

  constructor(private readonly keyOf: (value: T) => string) {}

  /** Record a wake before sending it, so a send that evaporates is still known. */
  owe(value: T): void {
    this.owed.set(this.keyOf(value), value);
  }

  /** The session showed the message: nothing left to re-send for that job. */
  delivered(key: string): void {
    this.owed.delete(key);
  }

  get size(): number {
    return this.owed.size;
  }

  /**
   * The wakes a settle may re-send. Each job gets one retry: a second abort during the retry drops the
   * message rather than looping, and every returned wake stops being owed either way.
   */
  takeForRetry(): T[] {
    const retry: T[] = [];
    for (const [key, value] of [...this.owed]) {
      this.owed.delete(key);
      if (this.redelivered.has(key)) continue;
      this.redelivered.add(key);
      retry.push(value);
    }
    return retry;
  }
}
