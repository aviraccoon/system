/**
 * Turn-budget nudging for delegated runs.
 *
 * A run that reaches its cap is aborted, and an aborted run returns whatever its
 * last message happened to be — frequently nothing usable. Telling the agent how
 * much budget is left gives it the chance to write up what it already has.
 */

/** Turns left when the nudge is sent: enough for one report-writing turn. */
export const NUDGE_TURNS_LEFT = 3;

/** Turn at which to nudge, or null when the budget is too small to act on. */
export function nudgeAt(maxTurns: number): number | null {
  const turn = maxTurns - NUDGE_TURNS_LEFT;
  return turn > 0 ? turn : null;
}

export function nudgeMessage(turnCount: number, maxTurns: number): string {
  const left = maxTurns - turnCount;
  return (
    `STOP INVESTIGATING — ${turnCount}/${maxTurns} turns used, ${left} left. ` +
    "Do not call any more tools. Write your final report now, from what you already have, " +
    "in the format the task asked for, and state explicitly what you could not verify. " +
    "A run that ends without a report is a failure however much it read."
  );
}

/**
 * The task message, with the cap stated up front. An agent that learns the
 * budget only from the nudge has already spent it; one that knows the cap from
 * turn zero can leave room to write.
 */
export function taskWithBudget(task: string, maxTurns: number): string {
  return (
    `Task: ${task}\n\n` +
    `Turn budget: ${maxTurns} turns. The run is aborted at turn ${maxTurns}, ` +
    "so leave room to write the report before then."
  );
}
