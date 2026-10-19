/**
 * Retry policy for subagent runs.
 *
 * A provider-side failure that left the run with no answer — the model returned
 * an error before producing one, or the child never produced a single message —
 * is worth another attempt: the next model in the role chain is a different
 * upstream, and even the same model can be routed to a different provider on
 * retry. A run that delivered an answer is not retried, whatever the stream did
 * at the end: the answer is the product, and a retry restarts the run and repeats
 * every tool call. A user abort or a turn-budget stop is not retried: the run did
 * what it was told. A natural stop with no usable answer is the sneaky third
 * case: the model reasons, narrates a plan, and stops without acting or
 * answering — the run claims success while carrying nothing.
 */

export const MAX_ATTEMPTS = 3;

/** Attempts a single model gets before the chain moves to the next one. */
export const REPEATS_PER_MODEL = 2;

export interface AttemptOutcome {
  stopReason?: string;
  exitCode: number;
  messageCount: number;
  /** The stopping message carries no answer text — the run carried nothing out. */
  outputEmpty?: boolean;
}

export function isRetryable(outcome: AttemptOutcome): boolean {
  if (outcome.stopReason === "aborted" || outcome.stopReason === "max_turns_exceeded") return false;
  // The answer is the product: an error after it arrived (a dropped stream at the
  // end) is reported with the answer, not bought again with a full re-run.
  if (outcome.outputEmpty === false) return false;
  if (outcome.stopReason === "error") return true;
  // A natural stop with no answer is a model failure, not a completed run.
  if (outcome.outputEmpty) return true;
  // Non-zero exit with nothing produced means the child never came up
  // (spawn failure, crash before the first message).
  return outcome.exitCode !== 0 && outcome.messageCount === 0;
}

/**
 * Models to try, in order. The first candidate gets a second attempt before
 * the chain moves on: a provider blip is the likeliest failure, and the same
 * model can be routed to a different upstream on retry. Pads with the last
 * candidate when the chain is shorter than the attempt budget, so a
 * single-model role still gets retries.
 *
 * Generic over the candidate: the caller's type carries more than the ref (a
 * per-model thinking level), and the plan must hand each attempt its own.
 */
export function attemptPlan<T>(candidates: readonly T[], maxAttempts: number = MAX_ATTEMPTS): T[] {
  if (candidates.length === 0) return [];
  const plan: T[] = [];
  for (const candidate of candidates) {
    for (let i = 0; i < REPEATS_PER_MODEL && plan.length < maxAttempts; i++) plan.push(candidate);
    if (plan.length >= maxAttempts) break;
  }
  const last = candidates[candidates.length - 1];
  while (plan.length < maxAttempts) plan.push(last);
  return plan;
}
