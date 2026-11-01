/**
 * Where a job's files live, and how its status is read back.
 *
 * A job is three files under one directory: the script that runs it, its log, and its status.
 * The status file is the durable record: the job's own wrapper appends the exit code and finish
 * time, so a later pi session can report a job that finished while nothing was watching. All
 * timestamps are whole seconds, because the wrapper has no portable sub-second clock.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface JobStatus {
  startedAt?: number;
  pid?: number;
  exit?: number;
  finishedAt?: number;
  killed?: boolean;
  timedOut?: boolean;
  /** The directory the command ran in; what scopes a job to a project in the footer and /jobs. */
  cwd?: string;
  /** The pi session that started it. Lets /jobs say `@other` and keeps bulk actions local. */
  session?: string;
}

export interface JobPaths {
  dir: string;
  script: string;
  cmd: string;
  log: string;
  status: string;
}

export interface JobRecord {
  id: string;
  paths: JobPaths;
  status: JobStatus;
  logBytes: number;
  /** The command as the caller wrote it; `(unknown)` for a record from before this file existed. */
  command: string;
}

export function jobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_JOBS_DIR ?? path.join(env.TMPDIR || os.tmpdir(), "pi-jobs");
}

/**
 * Create the jobs directory. Every writer and every opener goes through here, so its mode has one
 * home: private to the user, because a job's log is the command's raw output.
 */
export function ensureJobsDir(dir: string = jobsDir()): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** `j-<start time>-<4 hex>`, sortable by time and unique enough within one machine. */
export function newJobId(now: number = Date.now(), random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, "0");
  return `j-${now.toString(36)}-${suffix}`;
}

export function jobPaths(dir: string, id: string): JobPaths {
  return {
    dir,
    script: path.join(dir, `${id}.sh`),
    cmd: path.join(dir, `${id}.cmd`),
    log: path.join(dir, `${id}.log`),
    status: path.join(dir, `${id}.status`),
  };
}

/**
 * Parse a status file. Lines are `key=value` and later lines win, because the wrapper appends to
 * a file the parent already wrote. Unknown keys are ignored rather than rejected: the file is
 * written by two processes and a future field must not break an old reader.
 */
export function parseStatus(text: string): JobStatus {
  const status: JobStatus = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "cwd") {
      if (value) status.cwd = value;
      continue;
    }
    if (key === "session") {
      if (value) status.session = value;
      continue;
    }
    if (key === "killed" || key === "timed_out") {
      if (value === "1") {
        if (key === "killed") status.killed = true;
        else status.timedOut = true;
      }
      continue;
    }
    if (!/^\d+$/.test(value)) continue;
    const n = Number(value);
    if (key === "started") status.startedAt = n;
    else if (key === "pid") status.pid = n;
    else if (key === "exit") status.exit = n;
    else if (key === "finished") status.finishedAt = n;
  }
  return status;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function readJob(dir: string, id: string): JobRecord | undefined {
  const paths = jobPaths(dir, id);
  let text: string;
  try {
    text = fs.readFileSync(paths.status, "utf8");
  } catch {
    return undefined;
  }
  let command = "(unknown)";
  try {
    command = fs.readFileSync(paths.cmd, "utf8").trimEnd() || "(empty)";
  } catch {
    /* older record */
  }
  return { id, paths, status: parseStatus(text), logBytes: sizeOf(paths.log), command };
}

/** Finished records age out after three days; a record whose death nothing observed ages out an hour
 * after its last sign of life. */
const PRUNE_AFTER_SECONDS = 3 * 24 * 3600;
const LOST_GRACE_SECONDS = 3600;

/**
 * Whether a record may be deleted. A record with no finish time and no live process died outside
 * `killJob` (OOM, `kill -9`), so there is no death time to age on: use the later of its start and
 * its log's mtime, or a long job that was still writing would be pruned at the next session start
 * before anyone read it.
 */
export function shouldPrune(status: JobStatus, alive: boolean, now: number, logMtime?: number): boolean {
  if (alive) return false;
  if (status.finishedAt !== undefined) return now - status.finishedAt >= PRUNE_AFTER_SECONDS;
  const lastSeen = Math.max(status.startedAt ?? now, logMtime ?? 0);
  return now - lastSeen >= LOST_GRACE_SECONDS;
}

/**
 * Whether a record says the job is over: it carries an exit code, a finish time, or a kill or
 * timeout marker. Every decision about whether a job is still running reads this one.
 */
export function isSettled(status: JobStatus): boolean {
  return (
    status.exit !== undefined || status.finishedAt !== undefined || status.killed === true || status.timedOut === true
  );
}

/**
 * Whether a record needs a finish time stamped by the process that saw it die. A wrapper that wrote
 * its own tail already has one, a killed or timed-out record carries its marker instead, and a
 * record already stamped once is left alone so a second read cannot append another finish time.
 */
export function needsFinishStamp(status: JobStatus): boolean {
  return !isSettled(status);
}

/** Every job this machine knows about, newest first. Unreadable entries are skipped, not fatal. */
export function listJobs(dir: string): JobRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const jobs: JobRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".status")) continue;
    const job = readJob(dir, name.slice(0, -".status".length));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => (b.status.startedAt ?? 0) - (a.status.startedAt ?? 0));
}

export function appendStatus(statusPath: string, lines: string[]): void {
  fs.appendFileSync(statusPath, `${lines.join("\n")}\n`);
}
