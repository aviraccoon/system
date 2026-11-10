/**
 * Background subagent runs: a dispatch that returns a handle instead of an answer, and the two tools
 * a caller uses to collect it.
 *
 * A run's record lives in the jobs store, so `/jobs` lists it beside shell jobs and a later session
 * can read how it ended. The completion goes through `shared/wake-delivery`, the same path a shell
 * job's completion takes.
 *
 * The run does not survive the session: its answer only ever reaches the session that started it, so
 * every `session_shutdown` reason kills what is still running. A reload re-instantiates the extension
 * with an empty map, and a run nobody can wait on or be told about is an orphan.
 */

import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendStatus,
  ensureJobDir,
  ensureJobsDir,
  type JobPaths,
  jobPaths,
  jobsDir,
  newRunId,
} from "../shared/job-store";
import { markPending } from "../shared/pending-work";
import { WakeDelivery } from "../shared/wake-delivery";
import type { AgentConfig } from "./agents";
import { getFinalOutput, resultFailed, runSingleAgent, type SingleResult } from "./rpc";

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export interface BackgroundRun {
  id: string;
  agent: string;
  startedAt: number;
  status: RunStatus;
  /** The child's last reported answer or progress, empty until its first turn reports one. */
  output: string;
  sessionFile?: string;
  stopReason?: string;
  paths: JobPaths;
  abort: () => void;
  releasePending: () => void;
  /** Resolves when the run leaves `running`, whichever way it ends. */
  settled: Promise<void>;
}

export interface StartArgs {
  agents: AgentConfig[];
  agent: string;
  task: string;
  cwd?: string;
  maxTurns: number;
}

const DEFAULT_WAIT_MS = 30_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 10 * 60_000;
const TAIL_CHARS = 800;

/** More than this many children at once is a runaway, not a batch. */
const MAX_RUNNING_RUNS = 4;

/** Why a start is refused, or null. Refused before a child exists, so a cap costs no spawn. */
export function capacityRefusal(running: number): string | null {
  if (running < MAX_RUNNING_RUNS) return null;
  return `Too many background subagent runs (${running} of ${MAX_RUNNING_RUNS} running). Wait for one, or close it.`;
}

/** The one run a background dispatch names, or why it cannot run in the background at all. */
export function singleRun(plan: {
  mode: string;
  singleAgent?: string;
  singleTask?: string;
}): { agent: string; task: string } | { error: string } {
  if (plan.mode === "single" && plan.singleAgent && plan.singleTask) {
    return { agent: plan.singleAgent, task: plan.singleTask };
  }
  return { error: "Invalid parameters. background takes single mode: agent (or spec) plus task." };
}

/** A wait timeout is a wait limit, not an error: `<= 0` and absurd values clamp. */
export function clampWaitMs(ms?: number): number {
  if (ms === undefined || !Number.isFinite(ms)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.floor(ms)));
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The last `TAIL_CHARS` of an answer, so a wake carries the end of a long report and says it cut. */
export function tail(output: string, limit = TAIL_CHARS): string {
  if (output.length <= limit) return output;
  return `[... ${output.length - limit} characters cut ...]\n${output.slice(-limit)}`;
}

/** The message that reaches the parent when a run ends. One line of state, then the tail. */
export function completionText(run: {
  id: string;
  agent: string;
  status: RunStatus;
  elapsedMs: number;
  output: string;
  stopReason?: string;
  sessionFile?: string;
}): string {
  const state = run.status === "done" ? "finished" : run.status === "cancelled" ? "cancelled" : "failed";
  const reason = run.stopReason && run.status !== "done" ? ` (${run.stopReason})` : "";
  const body = tail(run.output.trim());
  const transcript = run.sessionFile ? `\n\n[subagent session: ${run.sessionFile}]` : "";
  return `Subagent ${run.id} ${state} [${run.agent}, ${elapsed(run.elapsedMs)}]${reason}:\n${body || "(no output)"}${transcript}`;
}

/** One line per run, for a `wait` or `close` result. */
export function runLine(run: { id: string; agent: string; status: RunStatus; elapsedMs: number }): string {
  return `${run.id} ${run.status} [${run.agent}, ${elapsed(run.elapsedMs)}]`;
}

/**
 * Resolve the ids a wait or close names: an exact id or a unique prefix, since a wake hands out the
 * full id and a model retyping one is where the mistakes come from.
 */
export function selectRuns<T extends { id: string }>(runs: T[], ids?: string[]): { runs: T[] } | { error: string } {
  if (!ids || ids.length === 0) return { runs };
  const chosen: T[] = [];
  for (const id of ids) {
    const exact = runs.find((run) => run.id === id);
    if (exact) {
      if (!chosen.includes(exact)) chosen.push(exact);
      continue;
    }
    const prefixed = runs.filter((run) => run.id.startsWith(id));
    if (prefixed.length === 1) {
      if (!chosen.includes(prefixed[0])) chosen.push(prefixed[0]);
      continue;
    }
    if (prefixed.length > 1) {
      return { error: `"${id}" matches several runs: ${prefixed.map((run) => run.id).join(", ")}` };
    }
    const known = runs.map((run) => run.id).join(", ") || "none";
    return { error: `No run "${id}". Running or finished here: ${known}` };
  }
  return { runs: chosen };
}

function writeStatus(paths: JobPaths, lines: string[]): void {
  fs.writeFileSync(paths.status, `${lines.join("\n")}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Running runs first, then newest first: what a wait with no ids should meet first. */
export function orderRuns<T extends { status: RunStatus; startedAt: number }>(runs: T[]): T[] {
  return [...runs].sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1;
    if (b.status === "running" && a.status !== "running") return 1;
    return b.startedAt - a.startedAt;
  });
}

/** The live runs of one extension instance, and the tools that read them. */
export class BackgroundRuns {
  private readonly runs = new Map<string, BackgroundRun>();
  private readonly delivery: WakeDelivery;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly spawn: typeof runSingleAgent = runSingleAgent,
  ) {
    this.delivery = new WakeDelivery(pi);
    // A run's answer only reaches the session that started it, so a session that ends takes its runs
    // with it. Nothing re-adopts them: the map is in memory, and the runtime that could send their
    // wakes is gone after a reload too.
    pi.on("session_shutdown", () => this.stopAll());
  }

  list(): BackgroundRun[] {
    return orderRuns([...this.runs.values()]);
  }

  start(ctx: ExtensionContext, args: StartArgs): { run: BackgroundRun } | { error: string } {
    const refusal = capacityRefusal(this.list().filter((run) => run.status === "running").length);
    if (refusal) return { error: refusal };
    const id = newRunId();
    ensureJobsDir();
    const paths = jobPaths(jobsDir(), id);
    ensureJobDir(paths.dir);
    fs.writeFileSync(paths.cmd, args.task);
    writeStatus(paths, [
      "kind=subagent",
      `started=${Math.floor(Date.now() / 1000)}`,
      `session=${ctx.sessionManager.getSessionId()}`,
      `cwd=${args.cwd ?? ctx.cwd}`,
    ]);

    const controller = new AbortController();
    let requested = false;
    let pid: number | undefined;
    let resolveSettled = (): void => {};
    const run: BackgroundRun = {
      id,
      agent: args.agent,
      startedAt: Date.now(),
      status: "running",
      output: "",
      paths,
      abort: () => {
        requested = true;
        controller.abort();
      },
      releasePending: markPending(ctx.sessionManager.getSessionId(), { kind: "subagent", id }),
      settled: new Promise<void>((resolve) => {
        resolveSettled = resolve;
      }),
    };
    this.runs.set(id, run);

    const onUpdate = (partial: { content: unknown[]; details?: { results: SingleResult[] } }) => {
      if (run.status !== "running") return;
      const first = partial.details?.results[0];
      if (!first) return;
      if (first.messages.length > 0) run.output = getFinalOutput(first.messages) || run.output;
      if (first.pid !== undefined && first.pid !== pid) {
        pid = first.pid;
        appendStatus(paths.status, [`pid=${first.pid}`]);
      }
      if (first.sessionFile !== undefined && first.sessionFile !== run.sessionFile) {
        run.sessionFile = first.sessionFile;
        appendStatus(paths.status, [`session_file=${run.sessionFile}`]);
      }
    };

    // Every child writes the same footer key, so a background child must not own the pill: the
    // foreground already has one, and two runs would erase each other as they finish. `ui` is a
    // getter on pi's context, so it is shadowed with `defineProperty` rather than assigned.
    const quietUi = Object.create(ctx.ui) as ExtensionContext["ui"];
    Object.defineProperty(quietUi, "setStatus", { value: () => {}, enumerable: true, configurable: true });
    const quietCtx = Object.create(ctx) as ExtensionContext;
    // Reading the parent's `ui` first keeps pi's stale-context check, which the getter performs.
    // Enumerable like pi's own getters, so a spread of the context keeps it.
    Object.defineProperty(quietCtx, "ui", {
      get: () => {
        void ctx.ui;
        return quietUi;
      },
      enumerable: true,
      configurable: true,
    });

    void this.spawn(
      ctx.cwd,
      args.agents,
      args.agent,
      args.task,
      args.cwd,
      undefined,
      controller.signal,
      onUpdate,
      (results) => ({ mode: "single" as const, agentScope: "user", results }),
      quietCtx,
      args.maxTurns,
      (handle) => {
        run.abort = () => {
          requested = true;
          handle.abort();
        };
        return () => {};
      },
    )
      .then((result) => this.settle(run, result, requested, resolveSettled))
      .catch((error: unknown) => {
        run.output = error instanceof Error ? error.message : String(error);
        this.settle(run, undefined, requested, resolveSettled);
      });

    return { run };
  }

  /** Record the end of a run, close its job record and send one wake. */
  private settle(
    run: BackgroundRun,
    result: SingleResult | undefined,
    requested: boolean,
    resolveSettled: () => void,
  ): void {
    if (run.status !== "running") return;
    // `resultFailed` is the foreground's rule: a turn-capped child exits 0, so exit code alone
    // would report a capped run as finished and drop the reason the wake exists to carry.
    const failed = result === undefined || resultFailed(result);
    run.status = requested ? "cancelled" : failed ? "failed" : "done";
    run.stopReason = result?.stopReason;
    if (result?.sessionFile && result.sessionFile !== run.sessionFile) {
      run.sessionFile = result.sessionFile;
    }
    if (result) run.output = result.errorMessage || result.stderr || getFinalOutput(result.messages) || run.output;
    const seconds = Math.floor(Date.now() / 1000);
    try {
      const markers =
        run.status === "cancelled"
          ? ["killed=1", `finished=${seconds}`]
          : // The child's own exit code, not a verdict: a turn-capped child exits 0 and still failed.
            [`exit=${result?.exitCode ?? 1}`, `finished=${seconds}`, ...(run.status === "failed" ? ["failed=1"] : [])];
      if (run.sessionFile) markers.push(`session_file=${run.sessionFile}`);
      appendStatus(run.paths.status, markers);
      if (run.output) fs.writeFileSync(run.paths.log, `${run.output}\n`);
    } catch {
      /* the record is best effort; the wake carries the answer either way */
    }
    run.releasePending();
    resolveSettled();

    const message = completionText({
      id: run.id,
      agent: run.agent,
      status: run.status,
      elapsedMs: Date.now() - run.startedAt,
      output: run.output,
      stopReason: run.stopReason,
      sessionFile: run.sessionFile,
    });
    this.delivery.send({
      key: run.id,
      customType: "subagent-completion",
      content: message,
      details: { runId: run.id, status: run.status },
    });
  }

  async wait(ids: string[] | undefined, timeoutMs: number): Promise<{ text: string }> {
    const found = selectRuns(this.list(), ids);
    if ("error" in found) return { text: found.error };
    if (found.runs.length === 0) return { text: "No background subagent runs in this session." };
    const runs = found.runs;
    const running = runs.filter((run) => run.status === "running");
    const waitingFrom = Date.now();
    if (running.length > 0) {
      await Promise.race([Promise.all(running.map((run) => run.settled)), sleep(timeoutMs)]);
    }
    const timedOut = runs.some((run) => run.status === "running");
    // A later abort must not re-send what this call already showed. The first delivery, if it is
    // still queued as a steer, is pi's to deliver; the ledger only owns the retry.
    for (const run of runs) {
      if (run.status !== "running") this.delivery.ack(run.id);
    }
    const lines = runs.map((run) => runLine({ ...run, elapsedMs: Date.now() - run.startedAt }));
    const answers = runs
      .filter((run) => run.status !== "running")
      .map((run) => {
        // This call acks the wake, so whatever the model learns about a stop has to be here.
        const reason = run.stopReason && run.status !== "done" ? ` (${run.stopReason})` : "";
        const transcript = run.sessionFile ? `\n[subagent session: ${run.sessionFile}]` : "";
        return `${run.id}${reason}:\n${tail(run.output.trim()) || "(no output)"}${transcript}`;
      });
    return {
      text: [
        timedOut ? `Still running after ${elapsed(Date.now() - waitingFrom)}.` : "",
        lines.join("\n"),
        answers.join("\n\n"),
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  close(id: string): { text: string } {
    const found = selectRuns(this.list(), [id]);
    if ("error" in found) return { text: found.error };
    const run = found.runs[0];
    const was = run.status;
    if (was === "running") run.abort();
    return { text: `${run.id} ${was === "running" ? "closing" : "already finished"} [${run.agent}]` };
  }

  private stopAll(): void {
    const running = this.list().filter((run) => run.status === "running");
    if (running.length === 0) return;
    for (const run of running) run.abort();
    try {
      this.pi.sendMessage(
        {
          customType: "subagent-shutdown",
          content: `Stopped ${running.length} background subagent ${running.length === 1 ? "run" : "runs"}: session shutdown.`,
          display: true,
        },
        { triggerTurn: false },
      );
    } catch {
      /* nothing left to report to */
    }
  }
}
