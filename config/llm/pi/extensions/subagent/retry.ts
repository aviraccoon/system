/**
 * Retry policy for subagent runs.
 *
 * A provider-side failure — the model returned an error, or the child never
 * produced a single message — is worth another attempt: the next model in the
 * role chain is a different upstream, and even the same model can be routed to
 * a different provider on retry. A user abort or a turn-budget stop is not:
 * the run did what it was told.
 */

export const MAX_ATTEMPTS = 3;

/** Attempts a single model gets before the chain moves to the next one. */
export const REPEATS_PER_MODEL = 2;

export interface AttemptOutcome {
  stopReason?: string;
  exitCode: number;
  messageCount: number;
}

export function isRetryable(outcome: AttemptOutcome): boolean {
  if (outcome.stopReason === "error") return true;
  if (outcome.stopReason === "aborted" || outcome.stopReason === "max_turns_exceeded") return false;
  // Non-zero exit with nothing produced means the child never came up
  // (spawn failure, crash before the first message).
  return outcome.exitCode !== 0 && outcome.messageCount === 0;
}

/**
 * Model refs to try, in order. The first candidate gets a second attempt before
 * the chain moves on: a provider blip is the likeliest failure, and the same
 * model can be routed to a different upstream on retry. Pads with the last
 * candidate when the chain is shorter than the attempt budget, so a
 * single-model role still gets retries.
 */
export function attemptPlan(candidates: readonly string[], maxAttempts: number = MAX_ATTEMPTS): string[] {
  if (candidates.length === 0) return [];
  const plan: string[] = [];
  for (const candidate of candidates) {
    for (let i = 0; i < REPEATS_PER_MODEL && plan.length < maxAttempts; i++) plan.push(candidate);
    if (plan.length >= maxAttempts) break;
  }
  const last = candidates[candidates.length - 1];
  while (plan.length < maxAttempts) plan.push(last);
  return plan;
}
