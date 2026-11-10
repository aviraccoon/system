/**
 * Where a job's files live, and how its status is read back.
 *
 * A job is one directory under the jobs directory, holding its generated script, the command as the
 * caller wrote it, its log, and its status. The status file is the record: the job's own wrapper
 * appends the exit code and finish time, so a later pi session can report a job that finished while
 * nothing was watching. It outlives pi and the session, not the machine: the jobs directory lives
 * under `$TMPDIR`, which the OS clears. All timestamps are whole seconds, because the wrapper has no
 * portable sub-second clock.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface JobStatus {
  /** A background subagent run writes `subagent`; a shell job leaves it unset. */
  kind?: string;
  startedAt?: number;
  pid?: number;
  exit?: number;
  finishedAt?: number;
  killed?: boolean;
  timedOut?: boolean;
  /** Set when the run settled as a failure, including a child that exited 0 (a turn cap). */
  failed?: boolean;
  /** The directory the run belongs to; the panel's scope cycle filters by it. */
  cwd?: string;
  /** The pi session that started it. Lets /jobs say `@other` and keeps bulk actions local. */
  session?: string;
  /** A subagent run's transcript, under `~/.pi/agent/subagent-sessions/`. */
  sessionFile?: string;
  /** The budget the caller declared, in seconds. /jobs shows how much of it is spent. */
  budgetSeconds?: number;
}

export interface JobPaths {
  /** The job's own directory, which is one level below the jobs directory. */
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
  /** `status.kind`, or `job` when the writer left it unset (every shell job does). */
  kind: string;
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

/** A subagent run's id: the job shape under its own prefix, so an id says which kind it names. */
export function newRunId(now: number = Date.now(), random: () => number = Math.random): string {
  return newJobId(now, random).replace(/^j-/, "s-");
}

export function jobPaths(dir: string, id: string): JobPaths {
  const own = path.join(dir, id);
  return {
    dir: own,
    script: path.join(own, "script.sh"),
    cmd: path.join(own, "command.txt"),
    log: path.join(own, "output.txt"),
    status: path.join(own, "status.txt"),
  };
}

/** One job's directory, with the mode the jobs directory has and for the same reason. */
export function ensureJobDir(jobDir: string): void {
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
}

/** Delete a job's whole directory. Best effort, like every other deletion of a temporary record. */
export function removeJob(dir: string, id: string): void {
  try {
    fs.rmSync(jobPaths(dir, id).dir, { recursive: true, force: true });
  } catch {
    /* a record another process is reading stays until it is not */
  }
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
    if (key === "kind") {
      if (value) status.kind = value;
      continue;
    }
    if (key === "cwd") {
      if (value) status.cwd = value;
      continue;
    }
    if (key === "session") {
      if (value) status.session = value;
      continue;
    }
    if (key === "session_file") {
      if (value) status.sessionFile = value;
      continue;
    }
    if (key === "killed" || key === "timed_out" || key === "failed") {
      if (value === "1") {
        if (key === "killed") status.killed = true;
        else if (key === "timed_out") status.timedOut = true;
        else status.failed = true;
      }
      continue;
    }
    if (!/^\d+$/.test(value)) continue;
    const n = Number(value);
    if (key === "started") status.startedAt = n;
    else if (key === "pid") status.pid = n;
    else if (key === "exit") status.exit = n;
    else if (key === "finished") status.finishedAt = n;
    else if (key === "budget") status.budgetSeconds = n;
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
    /* the record survives a command file that does not */
  }
  const status = parseStatus(text);
  return { id, paths, status, kind: status.kind ?? "job", logBytes: sizeOf(paths.log), command };
}

/** Finished records age out after three days; a record whose death nothing observed ages out an hour
 * after its last sign of life. */
const PRUNE_AFTER_SECONDS = 3 * 24 * 3600;
const LOST_GRACE_SECONDS = 3600;

/**
 * Whether a record may be deleted. Liveness only speaks for a record that says nothing about its own
 * end: the OS recycles pids, so a finished record's pid can belong to something else entirely. A
 * record with no finish time and no live process died outside `killJob` (OOM, `kill -9`), so there is
 * no death time to age on: use the later of its start and its log's mtime, or a long job that was
 * still writing would be pruned at the next session start before anyone read it.
 */
export function shouldPrune(status: JobStatus, alive: boolean, now: number, logMtime?: number): boolean {
  if (!isSettled(status) && alive) return false;
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
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const jobs: JobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = readJob(dir, entry.name);
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => (b.status.startedAt ?? 0) - (a.status.startedAt ?? 0));
}

export function appendStatus(statusPath: string, lines: string[]): void {
  fs.appendFileSync(statusPath, `${lines.join("\n")}\n`);
}

/**
 * Add a settled marker and its finish time, once. Two writers reach for the same marker: `killJob`
 * after it signals, and the exit handler that saw the death. Without the read, a timed-out record
 * carries the pair twice, with two finish times that need not agree.
 */
export function stampMarker(statusPath: string, marker: string, now = Math.floor(Date.now() / 1000)): boolean {
  let text: string;
  try {
    text = fs.readFileSync(statusPath, "utf8");
  } catch {
    return false;
  }
  if (text.split("\n").some((line) => line.trim() === marker)) return false;
  appendStatus(statusPath, [marker, `finished=${now}`]);
  return true;
}
