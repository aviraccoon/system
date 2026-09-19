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
 * Whether the turn that just ended is still working (it has tool calls to run)
 * rather than finishing with its final answer.
 *
 * The nudge is a steer, and a steer always starts a turn. After a run's final
 * answer there is no work left to interrupt, and the forced turn races
 * agent_end — a completed report was aborted that way. An errored or aborted
 * response is excluded for the same reason: pi emits turn_end then agent_end
 * for it with no further turn, even when a salvaged tool call is present.
 */
export function turnContinues(message: unknown): boolean {
  const stopReason = (message as { stopReason?: unknown } | undefined)?.stopReason;
  if (stopReason === "error" || stopReason === "aborted") return false;
  const content = (message as { content?: unknown } | undefined)?.content;
  return (
    Array.isArray(content) && content.some((part) => (part as { type?: unknown } | undefined)?.type === "toolCall")
  );
}

export interface NudgeDecision {
  /** Whether to steer the nudge on this turn. */
  send: boolean;
  /** The latch for the next turn; true once the nudge has been sent. */
  nudgeSent: boolean;
}

/**
 * The nudge's one-shot transition: whether to steer now and what the latch
 * becomes. Returning the next state keeps the at-most-once guarantee inside a
 * tested function instead of an assignment at the call site.
 *
 * Both halves of the condition matter. Steering a finished run forces a doomed
 * extra turn (a completed report was aborted that way), so a turn with no tool
 * calls is skipped. And the threshold turn itself may not be nudged — the run
 * can pass through it without tool calls and keep going on a queued steer — so
 * the latch lets a later working turn carry the nudge instead of losing it to
 * an equality check that has already passed.
 */
export function nextNudge(maxTurns: number, turnCount: number, message: unknown, nudgeSent: boolean): NudgeDecision {
  const at = nudgeAt(maxTurns);
  const send = !nudgeSent && at !== null && turnCount >= at && turnContinues(message);
  return { send, nudgeSent: nudgeSent || send };
}

/** The per-attempt nudge latch. */
export interface NudgeState {
  sent: boolean;
}

/**
 * Decide and apply: update the latch, and steer the write-up when the decision
 * says so. The latch lives in the state object so the at-most-once guarantee is
 * a property of this function rather than of an assignment at the call site.
 */
export function steerNudge(
  state: NudgeState,
  maxTurns: number,
  turnCount: number,
  message: unknown,
  steer: (text: string) => void,
): void {
  const decision = nextNudge(maxTurns, turnCount, message, state.sent);
  state.sent = decision.nudgeSent;
  if (decision.send) steer(nudgeMessage(turnCount, maxTurns));
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
