/**
 * Starting, watching and killing a job.
 *
 * A job runs as its own detached process group from a generated script, so it survives the tool
 * call, the turn, and pi itself. The script redirects its own output to the log and appends the
 * exit code to the status file, which is what makes the record readable after pi is gone. Nothing
 * here holds a pipe open: a pipe would be the thing that ties the job's life to pi's.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  appendStatus,
  ensureJobDir,
  ensureJobsDir,
  isSettled,
  type JobPaths,
  jobPaths,
  jobsDir,
  parseStatus,
  stampMarker,
} from "./paths";

/** How long a call may stay in the foreground before it becomes a job. */
export function foregroundWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.PI_JOBS_FOREGROUND_SECONDS);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(raw, 3600) * 1000 : 60_000;
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The generated script. `exec >>` (not a pipe) is the whole design: the job owns its output file,
 * and the wrapper owns the status tail, so both outlive the process that started them.
 */
export function buildScript(command: string, paths: Pick<JobPaths, "log" | "status">): string {
  // The command runs in a subshell on purpose: a command ending in `exit` or `exec` must not take
  // the wrapper with it, or the status tail never runs and the job looks lost for ever.
  return `#!/usr/bin/env bash
# pi job wrapper: the status tail is what lets a later session report this job.
exec >>${shQuote(paths.log)} 2>&1
(
${command}
)
__pi_job_exit=$?
printf 'exit=%s\\nfinished=%s\\n' "$__pi_job_exit" "$(date +%s)" >>${shQuote(paths.status)}
exit "$__pi_job_exit"
`;
}

export interface StartedJob {
  id: string;
  paths: JobPaths;
  child: ChildProcess;
  /** The spawn failure, if any. A child that never started emits `error` and no `exit`. */
  failure(): Error | undefined;
}

export interface StartJobOptions {
  id: string;
  command: string;
  cwd: string;
  dir?: string;
  env?: NodeJS.ProcessEnv;
  /** The pi session starting it, so /jobs can tell its own jobs from another window's. */
  session?: string;
  /** The caller's budget, recorded so /jobs can show how much of it is spent. */
  budgetSeconds?: number;
}

export function startJob(options: StartJobOptions): StartedJob {
  const dir = options.dir ?? jobsDir();
  ensureJobsDir(dir);
  const paths = jobPaths(dir, options.id);
  ensureJobDir(paths.dir);
  fs.writeFileSync(paths.script, buildScript(options.command, paths), { mode: 0o700 });
  fs.writeFileSync(paths.cmd, `${options.command}\n`);
  fs.writeFileSync(paths.log, "");
  // `cwd` is what scopes the job to a project: the footer and /jobs read it rather than repeating it
  // on every line. `session` is what keeps a bulk kill from reaching another window's build.
  const initial = [`started=${Math.floor(Date.now() / 1000)}`, `cwd=${options.cwd}`];
  if (options.session) initial.push(`session=${options.session}`);
  // Whole seconds: the record is display state, and the reader has no use for a fraction.
  if (options.budgetSeconds !== undefined) initial.push(`budget=${Math.max(1, Math.round(options.budgetSeconds))}`);
  appendStatus(paths.status, initial);

  const child = spawn("/bin/bash", [paths.script], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: "ignore",
  });
  if (child.pid !== undefined) appendStatus(paths.status, [`pid=${child.pid}`]);
  // Without this listener a failed spawn is an unhandled 'error' event, which takes pi down with
  // it, and the child emits no 'exit' for the tool to observe.
  let failure: Error | undefined;
  child.once("error", (err) => {
    failure = err;
  });
  // The parent keeps the exit event while it lives; unref only keeps the event loop clear.
  child.unref();
  return { id: options.id, paths, child, failure: () => failure };
}

/**
 * Resolve true when the child ends within `ms` (an exit or a spawn `error`); false when the window
 * closes first or the caller aborts. An abort ends the wait; what happens to the job is the caller's
 * decision.
 */
export function waitForExit(child: ChildProcess, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const onAbort = () => finish(false);
    const onError = () => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    child.once("exit", onExit);
    child.once("error", onError);
    if (signal?.aborted) finish(false);
    else signal?.addEventListener("abort", onAbort, { once: true });
    // A child that never spawned at all is already dead.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface KillResult {
  killed: boolean;
  reason?: string;
}

interface KillOptions {
  timedOut?: boolean;
}

/**
 * Kill the job's process group, then make the status say so. The wrapper cannot report a killed
 * job (a signal ends it before its tail runs), so this writes `killed` itself.
 */
export async function killJob(id: string, dir: string = jobsDir(), options: KillOptions = {}): Promise<KillResult> {
  const paths = jobPaths(dir, id);
  let status: string;
  try {
    status = fs.readFileSync(paths.status, "utf8");
  } catch {
    return { killed: false, reason: "no such job" };
  }
  const record = parseStatus(status);
  const pid = record.pid;
  if (pid === undefined) return { killed: false, reason: "job has no pid" };
  // A settled record is history: writing `killed` over its exit code would turn a success into a
  // kill and reset its elapsed time.
  if (isSettled(record)) return { killed: false, reason: "already finished" };
  const marker = options.timedOut ? "timed_out=1" : "killed=1";
  if (!isAlive(pid)) {
    stampMarker(paths.status, marker);
    return { killed: true, reason: "already gone" };
  }
  // Negative pid: the whole group, which is the job and everything it started.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The pid can vanish between the liveness check and the signal, which is not a refusal.
      if (!isAlive(pid)) {
        stampMarker(paths.status, marker);
        return { killed: true, reason: "already gone" };
      }
      return { killed: false, reason: "permission denied" };
    }
  }
  for (let i = 0; i < 20 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (isAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* the group is gone */
    }
  }
  // Once: the exit handler that saw this death may have written the same marker already.
  stampMarker(paths.status, marker);
  return { killed: true };
}

/** How much of a log is read. A viewer that says "last 1 MB" has to mean this number. */
export const LOG_READ_LIMIT = 1_000_000;

/** Read the whole log, capped. A job's own output is the payload, so no streaming is needed here. */
export function readLog(logPath: string, maxBytes = LOG_READ_LIMIT): string {
  try {
    const size = fs.statSync(logPath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
