import { describe, expect, test } from "bun:test";
import {
  abortOutcome,
  commandLabel,
  completionMessage,
  elapsedSeconds,
  formatElapsed,
  type JobView,
  jobState,
  statusLine,
  tailText,
} from "./format";

function view(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "j-1",
    command: "make build",
    status: { startedAt: 1_000 },
    alive: true,
    logBytes: 0,
    ...overrides,
  };
}

describe("formatElapsed", () => {
  test("seconds under a minute carry no zero padding", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(8)).toBe("8s");
    expect(formatElapsed(59)).toBe("59s");
  });

  test("minutes paste the seconds on", () => {
    expect(formatElapsed(60)).toBe("1m");
    expect(formatElapsed(192)).toBe("3m12s");
  });

  test("hours and days stay two units wide", () => {
    expect(formatElapsed(3_600)).toBe("1h");
    expect(formatElapsed(3_849)).toBe("1h04m");
    expect(formatElapsed(86_400)).toBe("1d");
    expect(formatElapsed(97_200)).toBe("1d3h");
  });

  test("a clock that went backwards never renders negative", () => {
    expect(formatElapsed(-5)).toBe("0s");
  });
});

describe("jobState", () => {
  test("a status with no exit is running only while the pid lives", () => {
    expect(jobState({ startedAt: 1 }, true).kind).toBe("running");
    expect(jobState({ startedAt: 1 }, false)).toEqual({ kind: "failed", label: "lost" });
  });

  test("a timeout outranks a kill, because every timeout is also a kill", () => {
    expect(jobState({ exit: 143, killed: true, timedOut: true }, false).kind).toBe("timedOut");
    expect(jobState({ exit: 143, killed: true }, false).kind).toBe("killed");
  });

  test("a record stamped finished without an exit is finished, not lost", () => {
    expect(jobState({ startedAt: 1_000, finishedAt: 1_010 }, false)).toEqual({ kind: "finished", label: "finished" });
  });

  test("an exit code decides success", () => {
    expect(jobState({ exit: 0 }, false).label).toBe("exit 0");
    expect(jobState({ exit: 2 }, false)).toEqual({ kind: "failed", label: "exit 2" });
  });
});

describe("tailText", () => {
  test("keeps the last lines", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    expect(tailText(text, 3)).toBe("line 7\nline 8\nline 9");
  });

  test("a byte cut lands on a line boundary", () => {
    const text = `${"x".repeat(50)}\nsecond\nthird`;
    expect(tailText(text, 10, 12)).toBe("third");
  });

  test("short text passes through untouched", () => {
    expect(tailText("hello", 10, 100)).toBe("hello");
  });
});

describe("statusLine", () => {
  test("nothing running means no footer", () => {
    expect(statusLine([view({ status: { startedAt: 1_000, exit: 0 } })], 1_010)).toBeUndefined();
  });

  test("an unfinished call that died is not shown as running", () => {
    expect(statusLine([view({ alive: false })], 1_010)).toBeUndefined();
  });

  test("two jobs are named, the rest are counted", () => {
    const views = [
      view({ id: "a", command: "make build", status: { startedAt: 1_000 } }),
      view({ id: "b", command: "npm test", status: { startedAt: 1_005 } }),
      view({ id: "c", command: "sleep 9", status: { startedAt: 1_000 } }),
    ];
    expect(statusLine(views, 1_130)).toBe("jobs 3 · make build 2m10s · npm test 2m05s +1");
  });

  test("a job belongs to the directory it started in", () => {
    const views = [
      view({ id: "a", command: "make build", cwd: "/work/acme", status: { startedAt: 1_000 } }),
      view({ id: "b", command: "npm test", cwd: "/work/other", status: { startedAt: 1_000 } }),
    ];
    expect(statusLine(views, 1_010, "/work/acme")).toBe("jobs 1 · make build 10s · +1 elsewhere");
  });

  test("work only in another directory is counted, never named", () => {
    const views = [view({ id: "b", command: "npm test", cwd: "/work/other", status: { startedAt: 1_000 } })];
    expect(statusLine(views, 1_010, "/work/acme")).toBe("jobs 1 elsewhere");
  });

  test("a record with no cwd is still shown when the footer is unscoped", () => {
    const views = [view({ id: "old", command: "make", status: { startedAt: 1_000 } })];
    expect(statusLine(views, 1_010, "/work/acme")).toBe("jobs 1 elsewhere");
    expect(statusLine(views, 1_010)).toBe("jobs 1 · make 10s");
  });
});

describe("abortOutcome", () => {
  const base = { aborted: true, exited: false, killed: false, finished: false };

  test("nothing to report when the call was not aborted, or had already finished", () => {
    expect(abortOutcome({ ...base, aborted: false })).toBe("none");
    expect(abortOutcome({ ...base, exited: true })).toBe("none");
  });

  test("a confirmed kill is the only thing that reports killed", () => {
    expect(abortOutcome({ ...base, killed: true })).toBe("killed");
    expect(abortOutcome({ ...base, killed: true, finished: true })).toBe("killed");
  });

  test("a failed kill with no recorded exit is a failure, not a promotion", () => {
    expect(abortOutcome(base)).toBe("failed");
    expect(abortOutcome({ ...base, finished: true })).toBe("already-finished");
  });
});

describe("commandLabel", () => {
  test("names the first line, not the whole script", () => {
    expect(commandLabel("make build\nmake test")).toBe("make build");
  });

  test("truncates with an ellipsis at the requested width", () => {
    expect(commandLabel("a".repeat(20), 10)).toBe(`${"a".repeat(9)}…`);
  });
});

describe("elapsed and completion message", () => {
  test("a finished job measures from start to finish", () => {
    expect(elapsedSeconds(view({ status: { startedAt: 1_000, finishedAt: 1_192 } }), 9_999)).toBe(192);
  });

  test("the wake message names the exit code, the time and the tail", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192, exit: 1 } }),
      1_200,
      "boom\n",
      1,
    );
    expect(message).toBe("[job j-1 finished: exit 1 after 3m12s]\n\nboom");
  });

  test("a stamped record with no exit says the exit is unknown, not that it is lost", () => {
    const message = completionMessage(view({ status: { startedAt: 1_000, finishedAt: 1_192 } }), 1_200, "", undefined);
    expect(message).toBe("[job j-1 finished: exit unknown after 3m12s]");
  });

  test("a job with no output carries only the header", () => {
    expect(completionMessage(view({ status: { startedAt: 1_000, finishedAt: 1_010, exit: 0 } }), 1_010, "", 0)).toBe(
      "[job j-1 finished: exit 0 after 10s]",
    );
  });
});
