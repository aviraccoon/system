import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jobPaths, parseStatus, readJob } from "./paths";
import { buildScript, foregroundWaitMs, isAlive, killJob, readLog, startJob, waitForExit } from "./runner";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-runner-"));
}

describe("foregroundWaitMs", () => {
  test("defaults to a minute and takes a positive env override", () => {
    expect(foregroundWaitMs({})).toBe(60_000);
    expect(foregroundWaitMs({ PI_JOBS_FOREGROUND_SECONDS: "5" })).toBe(5_000);
    expect(foregroundWaitMs({ PI_JOBS_FOREGROUND_SECONDS: "0" })).toBe(60_000);
    expect(foregroundWaitMs({ PI_JOBS_FOREGROUND_SECONDS: "nope" })).toBe(60_000);
  });
});

describe("buildScript", () => {
  test("the command runs in a subshell between the redirect and the exit tail", () => {
    const script = buildScript("make build", { log: "/tmp/l", status: "/tmp/s" });
    const lines = script.split("\n");
    expect(lines[0]).toBe("#!/usr/bin/env bash");
    expect(lines[2]).toBe("exec >>'/tmp/l' 2>&1");
    expect(lines[3]).toBe("(");
    expect(lines[4]).toBe("make build");
    expect(lines[5]).toBe(")");
    expect(script).toContain("printf 'exit=%s\\nfinished=%s\\n'");
  });

  test("paths with a quote are escaped, not broken", () => {
    const script = buildScript("true", { log: "/tmp/it's here", status: "/tmp/s" });
    expect(script).toContain("exec >>'/tmp/it'\\''s here' 2>&1");
  });
});

describe("a real job", () => {
  test("writes its output and its exit code, and a command's own exit does not skip the tail", async () => {
    const dir = tempDir();
    try {
      const job = startJob({ id: "j-test-0001", command: "echo hello; exit 3", cwd: dir, dir });
      expect(await waitForExit(job.child, 10_000)).toBe(true);
      const record = readJob(dir, "j-test-0001");
      expect(record?.status.exit).toBe(3);
      expect(record?.status.startedAt).toBeGreaterThan(0);
      expect(readLog(jobPaths(dir, "j-test-0001").log)).toContain("hello");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a background command that outlives the window reports running, then kills", async () => {
    const dir = tempDir();
    try {
      const job = startJob({ id: "j-test-0002", command: "sleep 30", cwd: dir, dir });
      expect(await waitForExit(job.child, 50)).toBe(false);
      const status = parseStatus(fs.readFileSync(jobPaths(dir, "j-test-0002").status, "utf8"));
      expect(isAlive(status.pid)).toBe(true);

      const result = await killJob("j-test-0002", dir);
      expect(result.killed).toBe(true);
      const after = readJob(dir, "j-test-0002");
      expect(after?.status.killed).toBe(true);
      expect(isAlive(status.pid)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("the timeout marker wins over the kill marker", async () => {
    const dir = tempDir();
    try {
      const job = startJob({ id: "j-test-0003", command: "sleep 30", cwd: dir, dir });
      await waitForExit(job.child, 50);
      await killJob("j-test-0003", dir, { timedOut: true });
      const after = readJob(dir, "j-test-0003");
      expect(after?.status.timedOut).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("killing a job twice is not an error", async () => {
    const dir = tempDir();
    try {
      startJob({ id: "j-test-0004", command: "sleep 30", cwd: dir, dir });
      expect((await killJob("j-test-0004", dir)).killed).toBe(true);
      const second = await killJob("j-test-0004", dir);
      expect(second).toEqual({ killed: false, reason: "already finished" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a finished job keeps its exit code when someone tries to kill it", async () => {
    const dir = tempDir();
    try {
      const job = startJob({ id: "j-test-0005", command: "true", cwd: dir, dir });
      await waitForExit(job.child, 10_000);
      expect(await killJob("j-test-0005", dir)).toEqual({ killed: false, reason: "already finished" });
      expect(readJob(dir, "j-test-0005")?.status.exit).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing job is refused, not crashed on", async () => {
    const dir = tempDir();
    try {
      expect(await killJob("j-nope", dir)).toEqual({ killed: false, reason: "no such job" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the status records the session that started the job", async () => {
    const dir = tempDir();
    try {
      const job = startJob({ id: "j-session-1", command: "true", cwd: dir, dir, session: "sess-42" });
      expect(await waitForExit(job.child, 10_000)).toBe(true);
      expect(readJob(dir, "j-session-1")?.status.session).toBe("sess-42");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a job with no session records none, so a bulk action cannot claim it", async () => {
    const dir = tempDir();
    try {
      const job = startJob({ id: "j-session-2", command: "true", cwd: dir, dir });
      expect(await waitForExit(job.child, 10_000)).toBe(true);
      expect(readJob(dir, "j-session-2")?.status.session).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
