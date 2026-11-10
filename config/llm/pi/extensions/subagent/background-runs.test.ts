import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { jobsDir, readJob } from "../shared/job-store";
import { listPending } from "../shared/pending-work";
import { BackgroundRuns } from "./background";
import type { SingleResult } from "./rpc";

interface Sent {
  message: Record<string, unknown>;
  options: Record<string, unknown>;
}

function fakePi() {
  const sent: Sent[] = [];
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const pi = {
    on: (name: string, handler: (event: Record<string, unknown>) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
      sent.push({ message, options });
    },
  };
  return { pi: pi as unknown as ExtensionAPI, sent, handlers };
}

function ctxFor(cwd: string): ExtensionContext {
  return { cwd, ui: {}, sessionManager: { getSessionId: () => "sess-1" } } as unknown as ExtensionContext;
}

const USAGE: SingleResult["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  contextTokens: 0,
  turns: 0,
};

function result(over: Partial<SingleResult>): SingleResult {
  return {
    agent: "worker",
    agentSource: "ad-hoc",
    task: "t",
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: USAGE,
    ...over,
  };
}

function assistant(text: string): SingleResult["messages"] {
  return [{ role: "assistant", content: [{ type: "text", text }] } as SingleResult["messages"][number]];
}

const spawnOf = (value: SingleResult | Promise<SingleResult>) =>
  (() => Promise.resolve(value)) as unknown as typeof import("./rpc").runSingleAgent;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-runs-"));
  process.env.PI_JOBS_DIR = path.join(dir, "jobs");
  process.env.PI_PENDING_WORK_DIR = path.join(dir, "pending");
});

afterEach(() => {
  delete process.env.PI_JOBS_DIR;
  delete process.env.PI_PENDING_WORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const startArgs = (task = "go") => ({
  agents: [],
  agent: "worker",
  task,
  maxTurns: 5,
});

describe("BackgroundRuns", () => {
  test("a finished run records the kind, the transcript and the exit, and wakes once", async () => {
    const { pi, sent } = fakePi();
    const runs = new BackgroundRuns(
      pi,
      spawnOf(result({ messages: assistant("found it"), sessionFile: "/tmp/child.jsonl" })),
    );
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);
    await started.run.settled;

    expect(started.run.status).toBe("done");
    expect(started.run.output).toBe("found it");
    const record = readJob(jobsDir(), started.run.id);
    if (!record) throw new Error("the run wrote no record");
    expect(record.kind).toBe("subagent");
    expect(record.status.exit).toBe(0);
    expect(record.status.sessionFile).toBe("/tmp/child.jsonl");
    expect(record.status.session).toBe("sess-1");
    expect(record.status.cwd).toBe(dir);
    expect(record.status.startedAt).toBeGreaterThan(0);
    expect(record.command).toBe("go");
    expect(fs.readFileSync(record.paths.log, "utf8")).toContain("found it");

    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe("subagent-completion");
    expect(sent[0].message.content).toContain("found it");
    expect(sent[0].message.content).toContain("[subagent session: /tmp/child.jsonl]");
    expect(sent[0].options).toEqual({ triggerTurn: true, deliverAs: "steer" });
    expect(listPending("sess-1")).toEqual([]);
  });

  test("a failed run keeps the child's reason instead of saying no output", async () => {
    const { pi } = fakePi();
    const runs = new BackgroundRuns(
      pi,
      spawnOf(result({ exitCode: 1, stderr: 'Unknown agent: "typo".', stopReason: "error" })),
    );
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);
    await started.run.settled;

    expect(started.run.status).toBe("failed");
    expect(started.run.output).toContain('Unknown agent: "typo"');
    const { text } = await runs.wait([started.run.id], 1_000);
    expect(text).toContain('Unknown agent: "typo"');
    expect(text).toContain("failed");
  });

  test("an error outranks partial text the child streamed before it died", async () => {
    const { pi } = fakePi();
    const runs = new BackgroundRuns(
      pi,
      spawnOf(result({ exitCode: 1, messages: assistant("partial work"), errorMessage: "provider blew up" })),
    );
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);
    await started.run.settled;

    expect(started.run.output).toBe("provider blew up");
  });

  test("wait returns the answer for a run that already finished", async () => {
    const { pi } = fakePi();
    const runs = new BackgroundRuns(pi, spawnOf(result({ messages: assistant("the answer") })));
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);
    await started.run.settled;

    const { text } = await runs.wait(undefined, 1_000);
    expect(text).toContain("done");
    expect(text).toContain("the answer");
  });

  test("close stops a running run and reports its previous state", async () => {
    const { pi } = fakePi();
    let finish = (): void => {};
    const pending = new Promise<SingleResult>((resolve) => {
      finish = () => resolve(result({ messages: assistant("late") }));
    });
    const runs = new BackgroundRuns(pi, spawnOf(pending));
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);

    expect(runs.close(started.run.id).text).toContain("closing");
    finish();
    await started.run.settled;
    expect(started.run.status).toBe("cancelled");
    expect(runs.close(started.run.id).text).toContain("already finished");
  });

  test("wait stops at its timeout and reports the run as still running", async () => {
    const { pi } = fakePi();
    let finish = (): void => {};
    const pending = new Promise<SingleResult>((resolve) => {
      finish = () => resolve(result({ exitCode: 1 }));
    });
    const runs = new BackgroundRuns(pi, spawnOf(pending));
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);

    const { text } = await runs.wait([started.run.id], 1_000);
    expect(text).toContain("Still running after 1s.");
    expect(text).toContain("running");
    finish();
    await started.run.settled;
  });

  test("every session-shutdown reason aborts the runs, a reload included", async () => {
    const { pi, handlers } = fakePi();
    const signals: AbortSignal[] = [];
    const never = new Promise<SingleResult>(() => {});
    const spawn = ((...args: unknown[]) => {
      signals.push(args[6] as AbortSignal);
      return never;
    }) as unknown as typeof import("./rpc").runSingleAgent;

    for (const reason of ["reload", "quit"]) {
      signals.length = 0;
      const runs = new BackgroundRuns(pi, spawn);
      expect("run" in runs.start(ctxFor(dir), startArgs())).toBe(true);
      expect("run" in runs.start(ctxFor(dir), startArgs("second"))).toBe(true);
      // A reload builds a fresh extension with an empty map, so a run it kept alive would be an
      // orphan: no tool could reach it and its wake has no runtime to send through.
      handlers.get("session_shutdown")?.({ reason });
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
    }
  });

  test("a mid-run update records the pid and the transcript, and a late one changes nothing", async () => {
    const { pi } = fakePi();
    let finish = (): void => {};
    let update = (_partial: unknown): void => {};
    const pending = new Promise<SingleResult>((resolve) => {
      finish = () => resolve(result({ messages: assistant("settled answer") }));
    });
    const spawn = ((...args: unknown[]) => {
      update = args[7] as (partial: unknown) => void;
      update({
        content: [],
        details: {
          results: [
            {
              agent: "worker",
              agentSource: "ad-hoc",
              task: "t",
              pid: 4242,
              sessionFile: "/tmp/mid.jsonl",
              messages: assistant("partial text"),
              exitCode: 0,
              stderr: "",
              usage: USAGE,
            },
          ],
        },
      });
      return pending;
    }) as unknown as typeof import("./rpc").runSingleAgent;
    const runs = new BackgroundRuns(pi, spawn);
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);

    const mid = readJob(jobsDir(), started.run.id);
    expect(mid?.status.pid).toBe(4242);
    expect(mid?.status.sessionFile).toBe("/tmp/mid.jsonl");
    expect(started.run.output).toBe("partial text");

    finish();
    await started.run.settled;
    update({ content: [], details: { results: [{ messages: assistant("late text") }] } });
    expect(started.run.output).not.toBe("late text");
  });

  test("a wait that shows the answer cancels the wake it would have sent", async () => {
    const { pi, sent, handlers } = fakePi();
    const runs = new BackgroundRuns(pi, spawnOf(result({ messages: assistant("the answer") })));
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);
    await started.run.settled;
    expect(sent).toHaveLength(1);

    await runs.wait([started.run.id], 1_000);
    handlers.get("agent_settled")?.({ aborted: true });
    expect(sent).toHaveLength(1);
  });

  test("wait names a failed run's stop reason, since it acks the wake", async () => {
    const { pi } = fakePi();
    // A turn-capped child exits 0, which is why the status has to come from `resultFailed`.
    const runs = new BackgroundRuns(
      pi,
      spawnOf(result({ exitCode: 0, messages: assistant("partial"), stopReason: "max_turns_exceeded" })),
    );
    const started = runs.start(ctxFor(dir), startArgs());
    if ("error" in started) throw new Error(started.error);
    await started.run.settled;

    expect(started.run.status).toBe("failed");
    const record = readJob(jobsDir(), started.run.id);
    expect(record?.status.exit).toBe(0);
    expect(record?.status.failed).toBe(true);
    const { text } = await runs.wait([started.run.id], 1_000);
    expect(text).toContain("(max_turns_exceeded)");
  });

  test("wait with nothing running says so", async () => {
    const { pi } = fakePi();
    const { text } = await new BackgroundRuns(pi).wait(undefined, 1_000);
    expect(text).toBe("No background subagent runs in this session.");
  });

  test("a background child cannot write the foreground footer", () => {
    const { pi } = fakePi();
    const calls: unknown[] = [];
    const modelRegistry = { find: () => undefined } as unknown as ExtensionContext["modelRegistry"];
    const ui = {
      setStatus: (key: string, value?: string) => calls.push([key, value]),
      notify: (text: string) => calls.push(["notify", text]),
    };
    // pi exposes `ui` as a getter on the context, so the fake does too: an assignment to it throws.
    let stale = false;
    const ctx = Object.create({
      cwd: dir,
      modelRegistry,
      sessionManager: { getSessionId: () => "sess-1" },
      get ui() {
        // pi's getter asserts the runner is still active; mimic that so the read is pinnable.
        if (stale) throw new Error("stale context");
        return ui;
      },
    }) as ExtensionContext;
    let received: ExtensionContext | undefined;
    const spawn = ((...args: unknown[]) => {
      received = args[9] as ExtensionContext;
      return new Promise<SingleResult>(() => {});
    }) as unknown as typeof import("./rpc").runSingleAgent;
    const runs = new BackgroundRuns(pi, spawn);
    runs.start(ctx, startArgs());

    if (!received) throw new Error("the child was handed no context");
    const child = received;
    // The shadow silences the pill and keeps every other member the child reads.
    child.ui.setStatus("subagent", "child");
    expect(calls).toEqual([]);
    child.ui.notify("hello");
    expect(calls).toEqual([["notify", "hello"]]);
    expect(child.modelRegistry).toBe(modelRegistry);
    // Enumerable like pi's own getters, so a spread of the context keeps `ui`.
    expect(Object.keys(child)).toContain("ui");
    stale = true;
    expect(() => child.ui).toThrow("stale context");
    stale = false;
    // The foreground context still writes, so the check is the override and not a dead fake.
    ctx.ui.setStatus("subagent", "parent");
    expect(calls).toEqual([
      ["notify", "hello"],
      ["subagent", "parent"],
    ]);
  });

  test("a shutdown reports the runs it stopped", () => {
    const { pi, sent, handlers } = fakePi();
    const never = new Promise<SingleResult>(() => {});
    const runs = new BackgroundRuns(pi, spawnOf(never));
    runs.start(ctxFor(dir), startArgs());
    handlers.get("session_shutdown")?.({ reason: "quit" });
    const shutdown = sent.find((item) => item.message.customType === "subagent-shutdown");
    expect(shutdown?.message.content).toContain("Stopped 1 background subagent run");
  });

  test("a fifth running dispatch is refused before a child exists", async () => {
    const { pi } = fakePi();
    const never = new Promise<SingleResult>(() => {});
    const runs = new BackgroundRuns(pi, spawnOf(never));
    for (let i = 0; i < 4; i++) {
      expect("run" in runs.start(ctxFor(dir), startArgs(`task ${i}`))).toBe(true);
    }
    const fifth = runs.start(ctxFor(dir), startArgs("task 4"));
    expect("error" in fifth && fifth.error).toContain("4 of 4");
    expect(runs.list()).toHaveLength(4);
  });
});
