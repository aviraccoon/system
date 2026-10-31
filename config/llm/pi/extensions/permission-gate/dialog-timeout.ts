/**
 * The deadline on the confirmation dialog.
 *
 * A gate that waits forever turns one unanswered question into a dead session, which
 * is the failure this exists to prevent: the agent stops at the first call it cannot
 * resolve on its own, and nothing downstream of it ever runs. The answer is not a
 * shorter wait but a real deadline, plus a reset on every keystroke, so a person who
 * is reading the dialog never loses it and a person who walked away always does.
 *
 * No pi imports: the clock and the timer arrive from the caller, so the tests drive
 * expiry and reset without waiting.
 */

export const DEFAULT_DIALOG_TIMEOUT_SECONDS = 180;
export const DIALOG_TIMEOUT_ENV = "PI_GATE_DIALOG_TIMEOUT_SECONDS";

/** The countdown appears only this close to expiry, so the dialog does not nag. */
export const COUNTDOWN_VISIBLE_MS = 30_000;

/** Consecutive unanswered dialogs after which a run reads as unattended. */
export const AWAY_AFTER_TIMEOUTS = 3;

const SECOND_MS = 1000;
const MAX_DIALOG_TIMEOUT_SECONDS = 3600;

/** A whole number of seconds in [0, MAX], or null when the value is not one. `0` waits forever. */
export function parseTimeoutSeconds(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw <= MAX_DIALOG_TIMEOUT_SECONDS ? raw : null;
  }
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const seconds = Number(text);
  return seconds <= MAX_DIALOG_TIMEOUT_SECONDS ? seconds : null;
}

export interface DialogBudget {
  /** Seconds before the dialog denies the call when nobody answers; `0` waits forever. */
  seconds: number;
  /** The environment value that was rejected, when one was set and unparseable. */
  invalidEnv?: string;
}

/**
 * The budget in force: the environment wins, then the saved preference, then the
 * default. An unparseable environment value is reported rather than silently
 * ignored, because the alternative is a deadline the user thinks they set and did not.
 */
export function resolveDialogBudget(
  env: string | undefined,
  stored: number | undefined,
  fallback: number = DEFAULT_DIALOG_TIMEOUT_SECONDS,
): DialogBudget {
  const fromEnv = parseTimeoutSeconds(env);
  if (fromEnv !== null) return { seconds: fromEnv };
  const seconds = parseTimeoutSeconds(stored) ?? fallback;
  const invalidEnv = env !== undefined && env.trim() !== "" ? env : undefined;
  return invalidEnv === undefined ? { seconds } : { seconds, invalidEnv };
}

/** `3 minutes`, `45 seconds`, for the reason the model reads. */
export function formatDuration(seconds: number): string {
  if (seconds > 0 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}

/** Whole seconds, rounding up: `28s`, `1s`. */
export function formatRemaining(ms: number): string {
  return `${Math.max(0, Math.ceil(ms / SECOND_MS))}s`;
}

/**
 * The confirmation dialogs in a row that went unanswered. A timeout adds one; any
 * answered dialog clears it, which is what makes the streak mean "nobody is here"
 * rather than "this dialog expired once".
 */
export function nextTimeoutStreak(previous: number, timedOut: boolean): number {
  return timedOut ? previous + 1 : 0;
}

/** The budgets the settings menu cycles through, in seconds. */
export const DIALOG_TIMEOUT_CHOICES = [30, 60, 180, 600, 0];

/** The next budget in the cycle; an off-cycle saved value restarts at the first. */
export function nextDialogTimeout(current: number, choices: number[] = DIALOG_TIMEOUT_CHOICES): number {
  const index = choices.indexOf(current);
  return choices[(index + 1) % choices.length] ?? DEFAULT_DIALOG_TIMEOUT_SECONDS;
}

/** How a budget reads in the settings screen and the status text. */
export function describeDialogTimeout(seconds: number): string {
  return seconds === 0 ? "wait forever" : formatDuration(seconds);
}

export interface DeadlineDeps {
  now: () => number;
  /** Call `callback` every `ms`, returning a cancel function. Not named `every`: biome
   *  reads that as the array method and demands a return value. */
  repeat: (callback: () => void, ms: number) => () => void;
}

export interface DeadlineHooks {
  onExpire: () => void;
  /** Fires once a second while the deadline is live; repaint the countdown here. */
  onTick?: () => void;
}

export interface DialogDeadline {
  /** Restart the countdown: someone touched the dialog. */
  touch: () => void;
  /** Milliseconds left, `Infinity` when there is no deadline. */
  remainingMs: () => number;
  /** The countdown line once it is close enough to show, else null. */
  label: () => string | null;
  /** Cancel the timer. Safe to call twice. */
  stop: () => void;
}

/**
 * A resettable deadline. The timer ticks once a second rather than scheduling one
 * shot at the deadline, because `touch` moves the deadline and the tick is also what
 * repaints the countdown.
 */
export function createDialogDeadline(seconds: number, hooks: DeadlineHooks, deps: DeadlineDeps): DialogDeadline {
  const budgetMs = seconds * SECOND_MS;
  let deadline = deps.now() + budgetMs;
  let stopped = false;
  let cancel: (() => void) | null = null;

  function stop() {
    stopped = true;
    cancel?.();
    cancel = null;
  }

  if (seconds > 0) {
    cancel = deps.repeat(() => {
      if (stopped) return;
      if (deps.now() >= deadline) {
        stop();
        hooks.onExpire();
        return;
      }
      hooks.onTick?.();
    }, SECOND_MS);
  }

  return {
    touch() {
      if (!stopped && seconds > 0) deadline = deps.now() + budgetMs;
    },
    remainingMs() {
      return seconds > 0 ? Math.max(0, deadline - deps.now()) : Number.POSITIVE_INFINITY;
    },
    label() {
      if (seconds <= 0 || stopped) return null;
      const remaining = deadline - deps.now();
      return remaining <= COUNTDOWN_VISIBLE_MS ? `denies in ${formatRemaining(remaining)}` : null;
    },
    stop,
  };
}
