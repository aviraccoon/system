import { describe, expect, it } from "bun:test";
import {
  createDialogDeadline,
  DEFAULT_DIALOG_TIMEOUT_SECONDS,
  describeDialogTimeout,
  formatDuration,
  formatRemaining,
  nextDialogTimeout,
  nextTimeoutStreak,
  parseTimeoutSeconds,
  resolveDialogBudget,
} from "./dialog-timeout";

describe("parseTimeoutSeconds", () => {
  it("accepts whole seconds from the environment text", () => {
    expect(parseTimeoutSeconds("180")).toBe(180);
    expect(parseTimeoutSeconds(" 45 ")).toBe(45);
  });

  it("treats 0 as a real choice", () => {
    expect(parseTimeoutSeconds("0")).toBe(0);
    expect(parseTimeoutSeconds(0)).toBe(0);
  });

  it("rejects anything that is not whole seconds in range", () => {
    for (const raw of ["", "   ", "abc", "-5", "1.5", "1e3", "3601"]) {
      expect(parseTimeoutSeconds(raw)).toBeNull();
    }
    expect(parseTimeoutSeconds(undefined)).toBeNull();
    expect(parseTimeoutSeconds(-1)).toBeNull();
    expect(parseTimeoutSeconds(180.5)).toBeNull();
  });
});

describe("resolveDialogBudget", () => {
  it("prefers the environment over the saved preference", () => {
    expect(resolveDialogBudget("30", 600).seconds).toBe(30);
  });

  it("lets the environment disable the deadline even when a preference is saved", () => {
    expect(resolveDialogBudget("0", 600).seconds).toBe(0);
  });

  it("falls back to the saved preference, then the default", () => {
    expect(resolveDialogBudget(undefined, 600).seconds).toBe(600);
    expect(resolveDialogBudget(undefined, undefined).seconds).toBe(DEFAULT_DIALOG_TIMEOUT_SECONDS);
  });

  it("reports an unparseable environment value and keeps a usable budget", () => {
    const budget = resolveDialogBudget("five minutes", 600);
    expect(budget).toEqual({ seconds: 600, invalidEnv: "five minutes" });
  });

  it("does not report an absent or empty environment value", () => {
    expect(resolveDialogBudget(undefined, 600).invalidEnv).toBeUndefined();
    expect(resolveDialogBudget("", 600).invalidEnv).toBeUndefined();
  });

  it("ignores an unparseable saved preference rather than failing closed to 0", () => {
    expect(resolveDialogBudget(undefined, Number.NaN).seconds).toBe(DEFAULT_DIALOG_TIMEOUT_SECONDS);
  });
});

describe("formatDuration", () => {
  it("names minutes and seconds the way a person reads them", () => {
    expect(formatDuration(180)).toBe("3 minutes");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(1)).toBe("1 second");
    expect(formatDuration(45)).toBe("45 seconds");
    expect(formatDuration(0)).toBe("0 seconds");
  });
});

describe("formatRemaining", () => {
  it("counts whole seconds, rounding up", () => {
    expect(formatRemaining(28_000)).toBe("28s");
    expect(formatRemaining(0)).toBe("0s");
    expect(formatRemaining(999)).toBe("1s");
  });
});

describe("nextTimeoutStreak", () => {
  it("counts unanswered dialogs in a row", () => {
    expect(nextTimeoutStreak(0, true)).toBe(1);
    expect(nextTimeoutStreak(2, true)).toBe(3);
  });

  it("any answered dialog clears the streak", () => {
    expect(nextTimeoutStreak(3, false)).toBe(0);
  });
});

describe("the settings cycle", () => {
  it("walks the choices and wraps, ending on wait-forever", () => {
    expect(nextDialogTimeout(30)).toBe(60);
    expect(nextDialogTimeout(180)).toBe(600);
    expect(nextDialogTimeout(600)).toBe(0);
    expect(nextDialogTimeout(0)).toBe(30);
  });

  it("restarts at the first choice when the saved value is off the cycle", () => {
    expect(nextDialogTimeout(45)).toBe(30);
  });

  it("describes wait-forever as a choice, not as a number", () => {
    expect(describeDialogTimeout(0)).toBe("wait forever");
    expect(describeDialogTimeout(180)).toBe("3 minutes");
  });
});

/** A deadline driven by a clock the test moves, with the interval captured rather than run. */
function harness(seconds: number) {
  let now = 1_000_000;
  const callbacks: Array<() => void> = [];
  const intervals: number[] = [];
  let cancels = 0;
  const expiries: number[] = [];
  const ticks: number[] = [];
  const deadline = createDialogDeadline(
    seconds,
    { onExpire: () => expiries.push(now), onTick: () => ticks.push(now) },
    {
      now: () => now,
      repeat: (callback, ms) => {
        callbacks.push(callback);
        intervals.push(ms);
        return () => {
          cancels += 1;
        };
      },
    },
  );
  return {
    deadline,
    expiries,
    ticks,
    intervals,
    cancels: () => cancels,
    /** Advance the clock, then run the captured interval callback once. */
    tick(advanceMs = 1000) {
      now += advanceMs;
      for (const callback of callbacks) callback();
    },
  };
}

describe("createDialogDeadline", () => {
  it("ticks once a second without expiring early", () => {
    const h = harness(10);
    expect(h.intervals).toEqual([1000]);
    h.tick();
    h.tick();
    expect(h.expiries).toEqual([]);
    expect(h.ticks).toEqual([1_000_000 + 1000, 1_000_000 + 2000]);
  });

  it("expires at the budget and only once", () => {
    const h = harness(3);
    h.tick();
    h.tick();
    h.tick(1000);
    h.tick(1000);
    expect(h.expiries.length).toBe(1);
    expect(h.cancels()).toBe(1);
  });

  it("moves the deadline on touch, so a reader never loses the dialog", () => {
    const h = harness(3);
    h.tick();
    h.tick();
    h.deadline.touch();
    h.tick();
    h.tick();
    expect(h.expiries).toEqual([]);
    h.tick();
    expect(h.expiries.length).toBe(1);
  });

  it("ignores touch after expiry", () => {
    const h = harness(1);
    h.tick();
    h.deadline.touch();
    h.tick();
    expect(h.expiries.length).toBe(1);
    expect(h.deadline.remainingMs()).toBe(0);
  });

  it("shows the countdown only in the last 30 seconds", () => {
    const h = harness(120);
    expect(h.deadline.label()).toBeNull();
    for (let i = 0; i < 89; i += 1) h.tick();
    expect(h.deadline.label()).toBeNull();
    h.tick();
    expect(h.deadline.label()).toBe("denies in 30s");
  });

  it("arms nothing when the deadline is disabled", () => {
    const h = harness(0);
    expect(h.intervals).toEqual([]);
    expect(h.deadline.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    expect(h.deadline.label()).toBeNull();
    h.deadline.touch();
    expect(h.deadline.remainingMs()).toBe(Number.POSITIVE_INFINITY);
    h.deadline.stop();
    expect(h.cancels()).toBe(0);
  });

  it("stops on request and reports nothing afterwards", () => {
    const h = harness(2);
    h.deadline.stop();
    expect(h.cancels()).toBe(1);
    expect(h.deadline.label()).toBeNull();
    h.tick();
    h.tick();
    expect(h.expiries).toEqual([]);
    expect(h.ticks).toEqual([]);
  });
});
