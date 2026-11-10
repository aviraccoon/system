import { describe, expect, test } from "bun:test";
import {
  capacityRefusal,
  clampWaitMs,
  completionText,
  elapsed,
  orderRuns,
  runLine,
  selectRuns,
  singleRun,
  tail,
} from "./background";

describe("clampWaitMs", () => {
  test("defaults, and clamps both ends", () => {
    expect(clampWaitMs()).toBe(30_000);
    expect(clampWaitMs(0)).toBe(1_000);
    expect(clampWaitMs(-5)).toBe(1_000);
    expect(clampWaitMs(1_500)).toBe(1_500);
    expect(clampWaitMs(60 * 60_000)).toBe(600_000);
    expect(clampWaitMs(Number.NaN)).toBe(30_000);
  });
});

describe("capacityRefusal", () => {
  test("refuses at the cap and names the way out", () => {
    expect(capacityRefusal(0)).toBeNull();
    expect(capacityRefusal(3)).toBeNull();
    const refusal = capacityRefusal(4);
    expect(refusal).toContain("4 of 4");
    expect(refusal).toContain("close it");
  });
});

describe("orderRuns", () => {
  test("running first, then newest first", () => {
    const old = { status: "done" as const, startedAt: 10 };
    const newer = { status: "done" as const, startedAt: 20 };
    const running = { status: "running" as const, startedAt: 5 };
    expect(orderRuns([old, running, newer])).toEqual([running, newer, old]);
  });
});

describe("singleRun", () => {
  test("names the one run, and refuses a chain or a batch", () => {
    expect(singleRun({ mode: "single", singleAgent: "worker", singleTask: "go" })).toEqual({
      agent: "worker",
      task: "go",
    });
    for (const plan of [{ mode: "chain" }, { mode: "parallel" }, { mode: "single" }]) {
      const result = singleRun(plan);
      expect("error" in result && result.error).toContain("takes single mode");
    }
  });
});

describe("elapsed", () => {
  test("seconds, minutes and hours", () => {
    expect(elapsed(0)).toBe("0s");
    expect(elapsed(59_000)).toBe("59s");
    expect(elapsed(61_000)).toBe("1m01s");
    expect(elapsed(3_600_000)).toBe("1h00m");
  });
});

describe("tail", () => {
  test("keeps a short answer whole", () => {
    expect(tail("done")).toBe("done");
  });

  test("marks what it cut", () => {
    const text = "x".repeat(100);
    const cut = tail(text, 10);
    expect(cut).toContain("90 characters cut");
    expect(cut.endsWith("x".repeat(10))).toBe(true);
  });
});

describe("completionText", () => {
  const base = { id: "s-1", agent: "researcher", status: "done" as const, elapsedMs: 61_000, output: "found it" };

  test("a finished run names the run, the agent, the time and the answer", () => {
    expect(completionText(base)).toBe("Subagent s-1 finished [researcher, 1m01s]:\nfound it");
  });

  test("a failed run carries its stop reason", () => {
    expect(completionText({ ...base, status: "failed", stopReason: "max_turns_exceeded" })).toBe(
      "Subagent s-1 failed [researcher, 1m01s] (max_turns_exceeded):\nfound it",
    );
  });

  test("a cancelled run does not use the failure wording", () => {
    expect(completionText({ ...base, status: "cancelled" })).toContain("Subagent s-1 cancelled");
  });

  test("an empty answer says so", () => {
    expect(completionText({ ...base, output: "  " })).toContain("(no output)");
  });
});

describe("runLine", () => {
  test("one line: id, status, agent, elapsed", () => {
    expect(runLine({ id: "s-1", agent: "researcher", status: "running", elapsedMs: 5_000 })).toBe(
      "s-1 running [researcher, 5s]",
    );
  });
});

describe("selectRuns", () => {
  const runs = [{ id: "s-1" }, { id: "s-1-aaaa" }, { id: "s-1-abbb" }, { id: "s-2-cccc" }];
  const selected = (ids?: string[]) => {
    const result = selectRuns(runs, ids);
    if ("error" in result) throw new Error(result.error);
    return result.runs;
  };

  test("no ids means every run", () => {
    expect(selected()).toEqual(runs);
  });

  test("an exact id wins over a prefix that would match several", () => {
    // `s-1` is a prefix of three other ids; exact-match precedence is what keeps it one run.
    expect(selected(["s-1"])).toEqual([{ id: "s-1" }]);
    expect(selected(["s-1-aaaa"])).toEqual([{ id: "s-1-aaaa" }]);
  });

  test("a unique prefix resolves", () => {
    expect(selected(["s-2"])).toEqual([{ id: "s-2-cccc" }]);
  });

  test("an ambiguous prefix names the candidates instead of guessing", () => {
    const result = selectRuns(runs, ["s-1-a"]);
    expect("error" in result && result.error).toContain("matches several runs");
    expect("error" in result && result.error).toContain("s-1-aaaa, s-1-abbb");
  });

  test("an unknown id lists what is here", () => {
    const result = selectRuns(runs, ["nope"]);
    expect("error" in result && result.error).toContain('No run "nope"');
    expect("error" in result && result.error).toContain("s-2-cccc");
  });
});
