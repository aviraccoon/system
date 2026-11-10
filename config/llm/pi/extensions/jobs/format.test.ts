import { describe, expect, test } from "bun:test";
import {
  abortOutcome,
  budgetView,
  commandBlock,
  commandLabel,
  completionMessage,
  elapsedSeconds,
  formatBytes,
  formatElapsed,
  type JobView,
  jobFailed,
  jobState,
  logLines,
  recordCount,
  statusLine,
  tailText,
  timeoutNotice,
  viewTitle,
  wakeSlices,
} from "./format";

function view(overrides: Partial<JobView> = {}): JobView {
  return {
    id: "j-1",
    command: "make build",
    kind: "job",
    status: { startedAt: 1_000 },
    alive: true,
    logBytes: 0,
    ...overrides,
  };
}

describe("viewTitle", () => {
  test("labels a subagent run and leaves a shell job bare", () => {
    expect(viewTitle(view())).toBe("make build");
    expect(viewTitle(view({ kind: "subagent", command: "check the diff" }))).toBe("subagent  check the diff");
  });

  test("never outgrows the width it was given", () => {
    expect(viewTitle(view({ kind: "subagent", command: "x".repeat(200) }), 40)).toHaveLength(40);
    expect(viewTitle(view({ command: "x".repeat(200) }), 40)).toHaveLength(40);
    // At the narrowest rows the label is dropped rather than leaving no task to read.
    expect(viewTitle(view({ kind: "subagent", command: "x".repeat(200) }), 10)).toHaveLength(10);
    expect(viewTitle(view({ kind: "subagent", command: "check the diff" }), 13)).toBe("check the di…");
  });
});

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

  test("a settled failure is a failure to the shell-job reader too", () => {
    expect(jobFailed({ exit: 0, failed: true })).toBe(true);
    expect(jobFailed({ exit: 0 })).toBe(false);
  });

  test("the footer labels a subagent run as one", () => {
    const running = view({ id: "a", kind: "subagent", command: "check the diff", status: { startedAt: 1_000 } });
    expect(statusLine([running], 1_010)).toBe("jobs 1 · subagent  check the diff 10s");
  });

  test("a settled failure outranks its exit code", () => {
    expect(jobState({ exit: 0, finishedAt: 5, failed: true }, false)).toEqual({ kind: "failed", label: "failed" });
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

describe("elapsed and the completion message", () => {
  test("a finished job measures from start to finish", () => {
    expect(elapsedSeconds(view({ status: { startedAt: 1_000, finishedAt: 1_192 } }), 9_999)).toBe(192);
  });

  test("the wake names the exit code, the time and the tail", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192, exit: 0 } }),
      1_200,
      { tail: "built ok", omitted: 0 },
      0,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toBe("[job j-1 finished: exit 0 after 3m12s]\n\nbuilt ok");
  });

  test("a failure names the log even when nothing was cut, so the rest is reachable", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192, exit: 1 } }),
      1_200,
      { tail: "boom", omitted: 0 },
      1,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toBe("[job j-1 finished: exit 1 after 3m12s]\n\nboom\n\nFull log: /tmp/pi-jobs/j-1.log");
  });

  test("a capped read names the log without claiming a line count", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192, exit: 0 } }),
      1_200,
      { tail: "cut", omitted: 0, capped: true },
      0,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toContain("… further output omitted");
    expect(message).not.toContain("lines omitted");
    expect(message).toContain("Full log: /tmp/pi-jobs/j-1.log");
  });

  test("a cut body says how much is missing and where the rest is", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192, exit: 0 } }),
      1_200,
      { head: "first", tail: "last", omitted: 40 },
      0,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toContain("first\n\n… 40 lines omitted\n\nlast");
    expect(message).toContain("Full log: /tmp/pi-jobs/j-1.log");
  });

  test("a stamped record with no exit says the exit is unknown, not that it is lost", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192 } }),
      1_200,
      { tail: "", omitted: 0 },
      undefined,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toBe("[job j-1 finished: exit unknown after 3m12s]");
  });

  test("a job with no output carries only the header", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_010, exit: 0 } }),
      1_010,
      { tail: "", omitted: 0 },
      0,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toBe("[job j-1 finished: exit 0 after 10s]");
  });
});

describe("wakeSlices", () => {
  const log = (lines: number): string => Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n");

  test("a short log arrives whole", () => {
    expect(wakeSlices("a\nb\n", true)).toEqual({ tail: "a\nb", omitted: 0 });
  });

  test("a passing job gets the tail only", () => {
    const slices = wakeSlices(log(100), false);
    expect(slices.head).toBeUndefined();
    expect(slices.tail.split("\n")).toHaveLength(80);
    expect(slices.tail.endsWith("line 100")).toBe(true);
    expect(slices.omitted).toBe(20);
  });

  test("a failure gets the head too, because the error sits above the tail", () => {
    const slices = wakeSlices(log(300), true);
    expect(slices.head?.split("\n")[0]).toBe("line 1");
    expect(slices.head?.split("\n")).toHaveLength(20);
    expect(slices.tail.endsWith("line 300")).toBe(true);
    expect(slices.omitted).toBe(200);
  });

  test("a failure short enough for a head and a tail to cover goes whole", () => {
    // 90 lines is past the tail alone, so cutting the first ten would hide the error for no gain.
    const slices = wakeSlices(log(90), true);
    expect(slices.head).toBeUndefined();
    expect(slices.tail.startsWith("line 1\n")).toBe(true);
    expect(slices.tail.endsWith("line 90")).toBe(true);
    expect(slices.omitted).toBe(0);
  });

  test("one line past that boundary takes the head again", () => {
    const slices = wakeSlices(log(101), true);
    expect(slices.head?.split("\n")[0]).toBe("line 1");
    expect(slices.omitted).toBe(1);
  });

  test("no output is no blocks", () => {
    expect(wakeSlices("", true)).toEqual({ tail: "", omitted: 0 });
    expect(wakeSlices("\n\n", false)).toEqual({ tail: "", omitted: 0 });
  });

  test("one huge line keeps its start instead of filling the block", () => {
    const slices = wakeSlices("x".repeat(20_000), false);
    expect(slices.tail).toBe(`${"x".repeat(399)}…`);
    expect(slices.omitted).toBe(0);
  });

  test("a huge line in the head is shortened the same way", () => {
    const long = "y".repeat(20_000);
    const slices = wakeSlices(`${long}\n${log(200)}`, true);
    expect(slices.head?.split("\n")[0]).toBe(`${"y".repeat(399)}…`);
    expect(slices.head?.split("\n")).toHaveLength(20);
    expect(Buffer.byteLength(slices.head ?? "")).toBeLessThanOrEqual(8_000);
  });

  test("a dense failing log is partitioned: nothing twice, nothing dropped", () => {
    // 20 long lines put the body past the byte budget while the tail of 70 short ones stays under it.
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => `${i + 1}`.padEnd(500, "x")),
      ...Array.from({ length: 70 }, (_, i) => `short ${i + 21}`),
    ];
    const slices = wakeSlices(lines.join("\n"), true);
    const head = slices.head?.split("\n") ?? [];
    const tail = slices.tail.split("\n");
    // The tail takes its 80 lines first, so the head is the ten before them and the two blocks cover
    // the log exactly once.
    expect(head).toHaveLength(10);
    expect(head[0]?.startsWith("1")).toBe(true);
    expect(tail).toHaveLength(80);
    expect(tail[0]?.startsWith("11")).toBe(true);
    expect(slices.omitted).toBe(0);
    expect(slices.capped).toBeUndefined();
    // The long lines are shortened to their first 399 characters; everything else arrives verbatim.
    expect(head[0]).toBe(`${(lines[0] as string).slice(0, 399)}…`);
    expect(tail.slice(10)).toEqual(lines.slice(20));
  });

  test("a dense failing log shows the tail alone when the tail covers it", () => {
    // Ten very long lines, shortened in place, so the tail holds the whole log and the head has no
    // line range of its own to take.
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}`.padEnd(1208, "x"));
    const slices = wakeSlices(lines.join("\n"), true);
    expect(slices.head).toBeUndefined();
    expect(slices.tail.split("\n")).toHaveLength(10);
    expect(slices.tail.split("\n")[9]?.endsWith("…")).toBe(true);
    expect(slices.tail.split("\n")[9]?.startsWith("10")).toBe(true);
    expect(slices.omitted).toBe(0);
  });

  test("a tail of long lines stops at the byte budget, and the count includes what it dropped", () => {
    // 300 lines of 400 characters: the 80-line tail alone would be 32 KB, four times the budget.
    const lines = Array.from({ length: 300 }, (_, i) => `${i + 1}`.padEnd(400, "x"));
    const slices = wakeSlices(lines.join("\n"), true);
    const head = slices.head?.split("\n") ?? [];
    const tail = slices.tail.split("\n");
    expect(head.length).toBeGreaterThan(0);
    expect(head.length).toBeLessThanOrEqual(20);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(80);
    expect(Buffer.byteLength(slices.head ?? "")).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(slices.tail)).toBeLessThanOrEqual(8_000);
    // The end of the log survives, and every line kept out of either block is counted as omitted.
    expect(tail[tail.length - 1]).toBe(lines[299]);
    expect(slices.omitted).toBe(300 - head.length - tail.length);
  });

  test("a line over the cap is never split mid-character", () => {
    // The 400th character of this line is half of an emoji; the cut must not leave a lone surrogate.
    const slices = wakeSlices(`${"a".repeat(398)}😀rest of the line`, false);
    expect(slices.tail).toBe(`${"a".repeat(398)}…`);
  });

  test("a short dense failure gives its first line to the head", () => {
    // 20 lines at the character cap are past the byte budget, so the tail drops its first line. That
    // line is where the error is, and the head exists to take it back.
    const lines = Array.from({ length: 20 }, (_, i) => `${i + 1}`.padEnd(400, "x"));
    const slices = wakeSlices(lines.join("\n"), true);
    expect(slices.head).toBe(lines[0]);
    expect(slices.tail.split("\n")).toHaveLength(19);
    expect(slices.tail.split("\n")[0]).toBe(lines[1]);
    expect(slices.omitted).toBe(0);
  });

  test("a capped read has no head to offer, and says it cannot count", () => {
    // The text is the tail of a bigger file: its first line is not the log's first line.
    const slices = wakeSlices(log(300), true, false);
    expect(slices.head).toBeUndefined();
    expect(slices.omitted).toBe(0);
    expect(slices.capped).toBe(true);
  });
});

describe("budgetView", () => {
  const spentOf = (spent: number, budget = 100) =>
    budgetView({ startedAt: 1_000, budgetSeconds: budget }, 1_000 + spent);

  test("says nothing when the caller declared no budget", () => {
    expect(budgetView({ startedAt: 1_000 }, 1_100)).toBeUndefined();
    expect(budgetView({ startedAt: 1_000, budgetSeconds: 0 }, 1_100)).toBeUndefined();
  });

  test("shows what is spent of it", () => {
    expect(spentOf(12)?.text).toBe("12s/1m40s");
  });

  test("warns at three quarters and turns red at nine tenths", () => {
    expect(spentOf(74)?.level).toBe("ok");
    expect(spentOf(75)?.level).toBe("warning");
    expect(spentOf(89)?.level).toBe("warning");
    expect(spentOf(90)?.level).toBe("error");
  });

  test("a settled job keeps its ratio but never reads as late", () => {
    const settled = budgetView({ startedAt: 1_000, finishedAt: 1_100, budgetSeconds: 100, exit: 0 }, 9_999);
    expect(settled).toEqual({ text: "1m40s/1m40s", level: "ok" });
  });
});

describe("jobFailed", () => {
  test("a non-zero exit, a kill and a timeout all count", () => {
    expect(jobFailed({ exit: 1 })).toBe(true);
    expect(jobFailed({ killed: true })).toBe(true);
    expect(jobFailed({ timedOut: true })).toBe(true);
  });

  test("success, a running job and an unknown fate do not", () => {
    expect(jobFailed({ exit: 0 })).toBe(false);
    expect(jobFailed({ startedAt: 1 })).toBe(false);
    expect(jobFailed({ startedAt: 1, finishedAt: 2 })).toBe(false);
  });
});

describe("timeoutNotice", () => {
  test("names the budget", () => {
    expect(timeoutNotice(300, 400, "make build")).toBe("Command timed out after its 5m budget");
  });

  test("explains an empty log when the command piped its output", () => {
    expect(timeoutNotice(300, 0, "make build | tail -30")).toContain("No output was captured");
  });

  test("does not guess a cause when nothing was piped", () => {
    expect(timeoutNotice(300, 0, "make build")).toBe("Command timed out after its 5m budget");
  });

  test("stays quiet when output was captured", () => {
    expect(timeoutNotice(300, 10, "make build | tail -30")).toBe("Command timed out after its 5m budget");
  });
});

describe("a wake whose tail fits keeps its count", () => {
  test("a log past the byte cap still counts the lines when its own tail was not cut", () => {
    // 3000 short lines are far past 8 KB in total, while the 80-line tail is a few hundred bytes.
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
    const slices = wakeSlices(lines, false);
    expect(slices.capped).toBeUndefined();
    expect(slices.omitted).toBe(2920);
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192, exit: 0 } }),
      1_200,
      slices,
      0,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toContain("… 2920 lines omitted");
  });

  test("the omitted count agrees in number", () => {
    const message = completionMessage(
      view({ status: { startedAt: 1_000, finishedAt: 1_192, exit: 1 } }),
      1_200,
      { tail: "t", omitted: 1 },
      1,
      "/tmp/pi-jobs/j-1.log",
    );
    expect(message).toContain("… 1 line omitted");
  });
});

describe("commandBlock", () => {
  test("marks the first line with a prompt so it cannot read as output", () => {
    expect(commandBlock("make build")).toEqual(["$ make build"]);
  });

  test("keeps a heredoc's body verbatim, indentation included", () => {
    expect(commandBlock("cat > f <<EOF\n  body\nEOF\n")).toEqual(["$ cat > f <<EOF", "  body", "EOF"]);
  });

  test("a command with only a trailing newline does not gain an empty last row", () => {
    expect(commandBlock("sleep 1\n")).toEqual(["$ sleep 1"]);
  });

  test("an empty command still renders one row", () => {
    expect(commandBlock("")).toEqual(["$ "]);
  });
});

describe("logLines", () => {
  test("keeps the whole log when it fits", () => {
    expect(logLines("a\nb\n")).toEqual(["a", "b"]);
  });

  test("a long log is tailed with a line saying what was cut", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const lines = logLines(text, 3);
    expect(lines[0]).toContain("7 lines above");
    expect(lines.slice(1)).toEqual(["line 7", "line 8", "line 9"]);
  });

  test("an empty log renders one empty line rather than nothing", () => {
    expect(logLines("")).toEqual([""]);
  });
});

describe("recordCount", () => {
  test("agrees in number", () => {
    expect(recordCount(1)).toBe("1 finished record");
    expect(recordCount(0)).toBe("0 finished records");
    expect(recordCount(12)).toBe("12 finished records");
  });
});

describe("formatBytes", () => {
  test("reads as a size", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(12_345)).toBe("12 KB");
    expect(formatBytes(1_234_567)).toBe("1.2 MB");
  });

  test("a negative count never renders below zero", () => {
    expect(formatBytes(-5)).toBe("0 B");
  });
});
