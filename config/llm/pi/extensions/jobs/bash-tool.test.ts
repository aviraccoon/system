import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createJobBashTool, type JobResultDetails, type SessionContext, sessionEnv } from "./bash-tool";
import { listJobs, readJob } from "./paths";
import { isAlive, killJob } from "./runner";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-jobs-tool-"));
}

async function waitForStatusFile(dir: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (listJobs(dir).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no status file appeared");
}

function statusPath(dir: string): string {
  const record = listJobs(dir)[0];
  if (record === undefined) throw new Error("no status file");
  return record.paths.status;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** The parts of `ctx` this tool reads; the property names are checked, the members a fake needs only. */
type TestContext = SessionContext & { cwd: string };

function sessionCtx(cwd: string, sessionId = "sess-test"): ExtensionContext {
  // Built as the narrow shape so its property names are checked, then widened for `execute`.
  const ctx: TestContext = {
    cwd,
    model: { provider: "openrouter", id: "vendor/model" } as SessionContext["model"],
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => "/sessions/s.jsonl",
    } as SessionContext["sessionManager"],
  };
  return ctx as unknown as ExtensionContext;
}

function tool(dir: string, foregroundMs: number, ctx: ExtensionContext = sessionCtx(dir)) {
  const promoted: string[] = [];
  const instance = createJobBashTool({
    dir,
    foregroundMs,
    hooks: { track: () => {}, promoted: (id) => promoted.push(id) },
  });
  const run = (params: { command: string; timeout?: number }) =>
    instance.execute("call", params, undefined, undefined, ctx);
  return { run, promoted, instance };
}

function outputOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => block.text ?? "").join("");
}

function detailsOf(result: unknown): Partial<JobResultDetails> {
  return ((result as { details?: Partial<JobResultDetails> }).details ?? {}) as Partial<JobResultDetails>;
}

describe("the bash tool", () => {
  test("the guideline scopes the edit ban to what a running job reads", () => {
    const { instance } = tool(path.join(os.tmpdir(), "unused"), 1000);
    expect(instance.promptGuidelines?.join("\n") ?? "").toContain("does not edit the files a running job is reading");
  });

  test("a command that finishes in the window returns its output and its exit code", async () => {
    const dir = tempDir();
    try {
      const { run } = tool(dir, 10_000);
      const ok = await run({ command: "printf 'one\\ntwo\\n'" });
      expect(outputOf(ok)).toBe("one\ntwo\n");
      expect(ok.isError).toBeFalsy();
      // The session log carries the id as data, not only inside the prose.
      expect(detailsOf(ok).jobId).toMatch(/^j-/);
      expect(detailsOf(ok).exitCode).toBe(0);
      expect(detailsOf(ok).promoted).toBeUndefined();

      const bad = await run({ command: "echo before; exit 4" });
      expect(outputOf(bad)).toContain("before");
      expect(outputOf(bad)).toContain("Command exited with code 4");
      expect(bad.isError).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("output past the advertised limit says where the rest is", async () => {
    const dir = tempDir();
    try {
      const { run } = tool(dir, 20_000);
      const result = await run({ command: "seq 1 3000" });
      const text = outputOf(result);
      expect(text).toContain("3000");
      expect(text).not.toContain("\n1\n");
      expect(text).toContain("Full output:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a byte cut also says where the rest is", async () => {
    const dir = tempDir();
    try {
      const { run } = tool(dir, 20_000);
      const result = await run({ command: "head -c 60000 /dev/zero | tr '\\0' 'a'" });
      expect(outputOf(result)).toContain("Full output:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("an aborted call kills the job instead of promoting it", async () => {
    const dir = tempDir();
    try {
      const promoted: string[] = [];
      const started: string[] = [];
      const instance = createJobBashTool({
        dir,
        foregroundMs: 10_000,
        hooks: { track: (job) => started.push(job.id), promoted: (id) => promoted.push(id) },
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const began = Date.now();
      const result = await instance.execute(
        "call",
        { command: "sleep 30" },
        controller.signal,
        undefined,
        sessionCtx(dir),
      );
      expect(Date.now() - began).toBeLessThan(5_000);
      expect(promoted).toHaveLength(0);
      expect(outputOf(result)).toContain("Command killed");
      expect(detailsOf(result)).toMatchObject({ killed: true });
      expect(result.isError).toBe(true);
      const record = readJob(dir, started[0]);
      expect(record?.status.killed).toBe(true);
      expect(isAlive(record?.status.pid)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("an abort whose kill is refused reports that instead of promoting", async () => {
    const dir = tempDir();
    let pid: number | undefined;
    try {
      const promoted: string[] = [];
      const instance = createJobBashTool({
        dir,
        foregroundMs: 10_000,
        hooks: {
          track: (job) => {
            pid = job.child.pid;
          },
          promoted: (id) => promoted.push(id),
        },
      });
      const controller = new AbortController();
      const pending = instance.execute("call", { command: "sleep 30" }, controller.signal, undefined, sessionCtx(dir));
      // Remove the record so the kill has nothing to read: the refusal path, not a finished job.
      await waitForStatusFile(dir);
      fs.rmSync(statusPath(dir));
      controller.abort();
      const result = await pending;
      expect(outputOf(result)).toContain("Command could not be stopped");
      // The refusal reason is data too, and must be the same text the model reads.
      expect(detailsOf(result).stopFailed).toBeTruthy();
      expect(outputOf(result)).toContain(detailsOf(result).stopFailed as string);
      expect(result.isError).toBe(true);
      expect(promoted).toHaveLength(0);
      expect(pid).toBeDefined();
      expect(isAlive(pid)).toBe(true);
    } finally {
      killGroup(pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("an escape after the record was stamped finished is not promoted", async () => {
    const dir = tempDir();
    let pid: number | undefined;
    try {
      const promoted: string[] = [];
      const instance = createJobBashTool({
        dir,
        foregroundMs: 10_000,
        hooks: {
          track: (job) => {
            pid = job.child.pid;
          },
          promoted: (id) => promoted.push(id),
        },
      });
      const controller = new AbortController();
      const pending = instance.execute(
        "call",
        { command: "sleep 30", timeout: 30 },
        controller.signal,
        undefined,
        sessionCtx(dir),
      );
      await waitForStatusFile(dir);
      // The shape `onExit` writes when a wrapper was killed from outside: a finish time and nothing
      // else. This is the record the narrower guard used to promote.
      fs.appendFileSync(statusPath(dir), `finished=${Math.floor(Date.now() / 1000)}\n`);
      controller.abort();
      const result = await pending;
      expect(promoted).toHaveLength(0);
      expect(result.isError).toBe(true);
      expect(outputOf(result)).toContain("Command terminated by signal");
    } finally {
      killGroup(pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("an escape after the budget already killed the job reports the timeout", async () => {
    const dir = tempDir();
    let pid: number | undefined;
    try {
      const promoted: string[] = [];
      const instance = createJobBashTool({
        dir,
        foregroundMs: 10_000,
        hooks: {
          track: (job) => {
            pid = job.child.pid;
          },
          promoted: (id) => promoted.push(id),
        },
      });
      const controller = new AbortController();
      const pending = instance.execute(
        "call",
        { command: "sleep 30", timeout: 30 },
        controller.signal,
        undefined,
        sessionCtx(dir),
      );
      await waitForStatusFile(dir);
      fs.appendFileSync(statusPath(dir), `timed_out=1\nfinished=${Math.floor(Date.now() / 1000)}\n`);
      controller.abort();
      const result = await pending;
      expect(outputOf(result)).toContain("Command timed out after its 30s budget");
      expect(detailsOf(result)).toMatchObject({ timedOut: true });
      expect(result.isError).toBe(true);
      expect(promoted).toHaveLength(0);
    } finally {
      killGroup(pid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("one abort kills every call it covers, so parallel calls leave nothing running", async () => {
    const dir = tempDir();
    try {
      const promoted: string[] = [];
      const started: string[] = [];
      const instance = createJobBashTool({
        dir,
        foregroundMs: 10_000,
        hooks: { track: (job) => started.push(job.id), promoted: (id) => promoted.push(id) },
      });
      const controller = new AbortController();
      const calls = ["sleep 30", "sleep 31"].map((command) =>
        instance.execute("call", { command }, controller.signal, undefined, sessionCtx(dir)),
      );
      setTimeout(() => controller.abort(), 200);
      const results = await Promise.all(calls);
      expect(promoted).toHaveLength(0);
      for (const result of results) expect(outputOf(result)).toContain("Command killed");
      for (const id of started) expect(isAlive(readJob(dir, id)?.status.pid)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a command still running after the window is promoted, not killed", async () => {
    const dir = tempDir();
    try {
      const { run, promoted } = tool(dir, 300);
      // The no-budget path is the common one; keep both it and the budgeted path pinned.
      const unbudgeted = await run({ command: "sleep 30" });
      expect(outputOf(unbudgeted)).toContain("no deadline");
      expect(detailsOf(unbudgeted).budgetSeconds).toBeUndefined();
      const result = await run({ command: "sleep 31", timeout: 30 });
      const text = outputOf(result);
      expect(promoted).toHaveLength(2);
      expect(text).toContain(`backgrounded as job ${promoted[1]}`);
      expect(text).toContain("killed when its 30s budget runs out");
      expect(text).toContain("Do NOT poll");
      // The two ways an agent fills the wait badly: it reads the log to check on the job, or it edits
      // the tree a test or linter job is reading. The read ban is scoped, because the completion's own
      // path notice is what licenses reading what it withheld.
      expect(text).toContain("to check on it");
      expect(text).toContain("editing them while it runs invalidates its result");
      // The log's path, because a model that wants the line above the tail has to be able to open it.
      expect(text).toContain(readJob(dir, promoted[1])?.paths.log ?? "(no record)");
      expect(readJob(dir, promoted[1])?.status.budgetSeconds).toBe(30);
      expect(result.isError).toBeFalsy();
      expect(detailsOf(result)).toMatchObject({ jobId: promoted[1], promoted: true, budgetSeconds: 30 });
      expect(detailsOf(result).exitCode).toBeUndefined();
      expect((await killJob(promoted[0], dir)).killed).toBe(true);
      expect((await killJob(promoted[1], dir)).killed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a budget reached inside the window is a timeout, and is declared before the kill", async () => {
    const dir = tempDir();
    try {
      const promoted: string[] = [];
      const kinds: string[] = [];
      const snapshots: string[] = [];
      const instance = createJobBashTool({
        dir,
        foregroundMs: 10_000,
        hooks: {
          track: () => {},
          promoted: (id) => promoted.push(id),
          killed: (_id, kind) => {
            kinds.push(kind);
            // The point of the fix: the extension is told before the marker is on disk, so its wake
            // label cannot depend on winning a race with the killer.
            snapshots.push(fs.readFileSync(statusPath(dir), "utf8"));
          },
        },
      });
      const result = await instance.execute(
        "call",
        { command: "sleep 30", timeout: 1 },
        undefined,
        undefined,
        sessionCtx(dir),
      );
      expect(outputOf(result)).toContain("Command timed out after its 1s budget");
      // No pipe and an empty log for a different reason: saying "the pipe" here would be a guess.
      expect(outputOf(result)).not.toContain("No output was captured");
      expect(detailsOf(result)).toMatchObject({ timedOut: true });
      expect(result.isError).toBe(true);
      expect(promoted).toHaveLength(0);
      expect(kinds).toEqual(["timedOut"]);
      expect(snapshots[0]).not.toContain("timed_out=1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a timeout that captured nothing from a piped command says why", async () => {
    const dir = tempDir();
    try {
      const { run } = tool(dir, 10_000);
      // The shape that lost the debugger run five minutes of work: the pipe only writes at EOF.
      const result = await run({ command: "sleep 30 | cat", timeout: 1 });
      const text = outputOf(result);
      expect(text).toContain("Command timed out after its 1s budget");
      expect(text).toContain("No output was captured");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a command that cannot start is an error, not a promotion", async () => {
    const dir = tempDir();
    try {
      const promoted: string[] = [];
      const broken = createJobBashTool({
        dir,
        foregroundMs: 30_000,
        hooks: { track: () => {}, promoted: (id) => promoted.push(id) },
      });
      const started = Date.now();
      const failed = await broken.execute(
        "call",
        { command: "true" },
        undefined,
        undefined,
        sessionCtx(path.join(dir, "missing")),
      );
      // The pin that matters: a spawn failure ends the wait instead of sitting out the window.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(outputOf(failed)).toContain("Command could not start:");
      expect(detailsOf(failed).spawnFailed).toBeTruthy();
      expect(outputOf(failed)).toContain(detailsOf(failed).spawnFailed as string);
      expect(failed.isError).toBe(true);
      expect(promoted).toHaveLength(0);
      expect(fs.readdirSync(dir)).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a job killed from outside reports the signal, not a null exit code", async () => {
    const dir = tempDir();
    try {
      const { run, promoted } = tool(dir, 10_000);
      const pending = run({ command: "sleep 30" });
      // Wait for the pid the wrapper recorded, then kill the whole group so the wrapper cannot
      // write its own exit line either.
      let pid: number | undefined;
      for (let i = 0; i < 50 && pid === undefined; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        pid = listJobs(dir)[0]?.status.pid;
      }
      expect(pid).toBeDefined();
      process.kill(-(pid as number), "SIGKILL");
      const result = await pending;
      expect(outputOf(result)).toContain("Command terminated by signal SIGKILL");
      expect(detailsOf(result)).toMatchObject({ signal: "SIGKILL" });
      expect(result.isError).toBe(true);
      expect(promoted).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("a non-positive timeout is refused before anything runs", async () => {
    const dir = tempDir();
    try {
      const { run } = tool(dir, 10_000);
      const refusal = async (timeout: number): Promise<string> => {
        try {
          await run({ command: "true", timeout });
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        throw new Error(`timeout ${timeout} was accepted`);
      };
      expect(await refusal(0)).toContain("Invalid timeout: must be a finite number of seconds");
      expect(await refusal(10_000)).toContain("maximum is 3600 seconds");
      expect(fs.readdirSync(dir)).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the session environment", () => {
  test("mirrors pi's shell-tool injection, replacing any inherited values", () => {
    const env = sessionEnv(sessionCtx("/work", "sess-7"), { PI_SESSION_ID: "stale", PATH: "/bin" });
    expect(env.PI_SESSION_ID).toBe("sess-7");
    expect(env.PI_SESSION_FILE).toBe("/sessions/s.jsonl");
    expect(env.PI_PROVIDER).toBe("openrouter");
    expect(env.PI_MODEL).toBe("vendor/model");
    expect(env.PI_REASONING_LEVEL).toBe("high");
    expect(env.PATH).toBe("/bin");
  });

  test("an optional part of the context missing leaves no stale value behind", () => {
    const ctx: SessionContext = {
      model: undefined,
      thinkingLevel: undefined,
      sessionManager: {
        getSessionId: () => "sess-8",
        getSessionFile: () => undefined,
      } as SessionContext["sessionManager"],
    };
    const env = sessionEnv(ctx, {
      PI_SESSION_ID: "stale",
      PI_SESSION_FILE: "stale",
      PI_PROVIDER: "stale",
      PI_MODEL: "stale",
      PI_REASONING_LEVEL: "stale",
      PATH: "/bin",
    });
    expect(env.PI_SESSION_ID).toBe("sess-8");
    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.PI_PROVIDER).toBeUndefined();
    expect(env.PI_MODEL).toBeUndefined();
    expect(env.PI_REASONING_LEVEL).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  test("without a context, inherited values are dropped rather than naming another session", () => {
    const env = sessionEnv(undefined, { PI_SESSION_ID: "stale", PATH: "/bin" });
    expect(env.PI_SESSION_ID).toBeUndefined();
    expect(env.PI_SESSION_FILE).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  test("the command sees the session, which is the review gate's marker", async () => {
    const dir = tempDir();
    try {
      const { run } = tool(dir, 10_000, sessionCtx(dir, "sess-e2e"));
      const result = await run({ command: `printf '%s\\n' "$PI_SESSION_ID" "$PI_PROVIDER" "$PI_MODEL"` });
      expect(outputOf(result).trim().split("\n")).toEqual(["sess-e2e", "openrouter", "vendor/model"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
