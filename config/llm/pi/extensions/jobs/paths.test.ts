import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jobPaths, jobsDir, listJobs, needsFinishStamp, newJobId, parseStatus, readJob, shouldPrune } from "./paths";

describe("jobsDir", () => {
  test("PI_JOBS_DIR wins", () => {
    expect(jobsDir({ PI_JOBS_DIR: "/tmp/custom" })).toBe("/tmp/custom");
  });

  test("otherwise a pi-jobs directory under TMPDIR", () => {
    expect(jobsDir({ TMPDIR: "/tmp/x" })).toBe("/tmp/x/pi-jobs");
  });
});

describe("newJobId", () => {
  test("is time-ordered and suffixed", () => {
    expect(newJobId(1_700_000_000_000, () => 0.5)).toMatch(/^j-[0-9a-z]+-[0-9a-f]{4}$/);
    expect(newJobId(1_700_000_000_000, () => 0)).not.toBe(newJobId(1_700_000_000_000, () => 0.9));
  });
});

describe("parseStatus", () => {
  test("later lines win, because the wrapper appends to a file the parent wrote", () => {
    expect(parseStatus("started=100\npid=42\nexit=0\nfinished=120")).toEqual({
      startedAt: 100,
      pid: 42,
      exit: 0,
      finishedAt: 120,
    });
    expect(parseStatus("exit=1\nexit=0").exit).toBe(0);
  });

  test("killed and timed_out are flags, not numbers", () => {
    expect(parseStatus("killed=1\ntimed_out=1")).toEqual({ killed: true, timedOut: true });
    expect(parseStatus("killed=0")).toEqual({});
  });

  test("unknown keys and junk lines are ignored", () => {
    expect(parseStatus("future=7\nnonsense\nstarted=abc\nstarted=9")).toEqual({ startedAt: 9 });
  });
});

describe("needsFinishStamp", () => {
  test("a wrapper tail is left alone", () => {
    expect(needsFinishStamp({ exit: 0, finishedAt: 1_000 })).toBe(false);
    expect(needsFinishStamp({ exit: 1, finishedAt: 1_000 })).toBe(false);
  });

  test("a killed or timed-out record carries its own marker", () => {
    expect(needsFinishStamp({ killed: true })).toBe(false);
    expect(needsFinishStamp({ timedOut: true })).toBe(false);
  });

  test("a record with no tail is stamped by whoever saw the exit", () => {
    expect(needsFinishStamp({ startedAt: 1_000, pid: 42 })).toBe(true);
  });

  test("a record that already carries a finish time is not restamped", () => {
    expect(needsFinishStamp({ startedAt: 1_000, finishedAt: 1_010 })).toBe(false);
  });
});

describe("shouldPrune", () => {
  const now = 1_000_000;

  test("a live record is never pruned, however old", () => {
    expect(shouldPrune({ startedAt: now - 10 * 86_400, finishedAt: 1 }, true, now)).toBe(false);
  });

  test("a finished record goes after three days", () => {
    expect(shouldPrune({ finishedAt: now - 3 * 86_400 }, false, now)).toBe(true);
    expect(shouldPrune({ finishedAt: now - 86_400 }, false, now)).toBe(false);
  });

  test("a record with no finish time ages from its last output, not its start", () => {
    // A build that ran five hours and was killed from outside keeps its log: the mtime is recent.
    const status = { startedAt: now - 5 * 3_600 };
    expect(shouldPrune(status, false, now, now - 60)).toBe(false);
    expect(shouldPrune(status, false, now, now - 2 * 3_600)).toBe(true);
  });

  test("without a log mtime the start is the only clock", () => {
    expect(shouldPrune({ startedAt: now - 30 * 60 }, false, now)).toBe(false);
    expect(shouldPrune({ startedAt: now - 90 * 60 }, false, now)).toBe(true);
  });
});

describe("listJobs and readJob", () => {
  test("no directory reads as no jobs", () => {
    expect(listJobs(path.join(os.tmpdir(), "pi-jobs-does-not-exist"))).toEqual([]);
  });

  test("jobs come newest first and carry their log size", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-test-"));
    try {
      fs.writeFileSync(path.join(dir, "a.status"), "started=100\npid=1\nexit=0\nfinished=110\n");
      fs.writeFileSync(path.join(dir, "b.status"), "started=200\n");
      fs.writeFileSync(jobPaths(dir, "b").log, "hello\n");
      const jobs = listJobs(dir);
      expect(jobs.map((j) => j.id)).toEqual(["b", "a"]);
      expect(jobs[0].logBytes).toBe(6);
      expect(readJob(dir, "missing")).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
