// rclone invocation and parsing of the log lines it writes. The counters read
// rclone's own log messages rather than its summary block, so they survive
// format changes in the summary and never match a filename.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface SyncOptions {
  src: string;
  dest: string;
  filterFile: string;
  logFile: string;
  bwLimit?: string;
  dryRun?: boolean;
  /** `mirror` also removes what the filters exclude, `copy` only adds. */
  mode?: "mirror" | "copy";
  /** Extra rclone flags for this destination's provider. */
  extraFlags?: string[];
}

export function syncArgs(opts: SyncOptions): string[] {
  const args = [
    "sync",
    opts.src,
    opts.dest,
    "--filter-from",
    opts.filterFile,
    "--transfers",
    "16",
    "--log-file",
    opts.logFile,
    "--log-level",
    "INFO",
  ];
  // Mirror destinations remove excluded and vanished files; copy destinations
  // (cold replicas) never delete. Both recover through the bucket lifecycle.
  if ((opts.mode ?? "mirror") === "mirror") args.push("--delete-excluded");
  if (opts.bwLimit) args.push("--bwlimit", opts.bwLimit);
  if (opts.dryRun) args.push("--dry-run");
  if (opts.extraFlags) args.push(...opts.extraFlags);
  return args;
}

export interface Counts {
  copied: number;
  changed: number;
  deleted: number;
}

export function parseCounts(lines: string[]): Counts {
  const counts: Counts = { copied: 0, changed: 0, deleted: 0 };
  for (const line of lines) {
    if (/: Copied \(new\)$/.test(line)) counts.copied++;
    else if (/: Copied \(replaced/.test(line)) counts.changed++;
    else if (/: Deleted$/.test(line)) counts.deleted++;
  }
  return counts;
}

export function remoteName(dest: string): string {
  const colon = dest.indexOf(":");
  return colon < 0 ? "" : dest.slice(0, colon);
}

export function remoteConfigured(remotes: string[], dest: string): boolean {
  const name = remoteName(dest);
  return name !== "" && remotes.includes(`${name}:`);
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): { status: number; out: string } {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env,
  });
  return { status: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function rcloneReady(rclone: string, env?: NodeJS.ProcessEnv): { ok: boolean; reason?: string } {
  const version = run(rclone, ["version"], env);
  if (version.status !== 0) return { ok: false, reason: `rclone not runnable (${rclone})` };
  return { ok: true };
}

export function remotes(rclone: string, env?: NodeJS.ProcessEnv): string[] {
  const result = run(rclone, ["listremotes"], env);
  if (result.status !== 0) return [];
  return result.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Run one sync. stderr is appended to the log: flag errors never reach it. */
export function runSync(rclone: string, args: string[], logFile: string, env?: NodeJS.ProcessEnv): number {
  const result = spawnSync(rclone, args, { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", env });
  const stderr = (result.stderr ?? "").trim();
  if (stderr) {
    const stamp = new Date().toISOString();
    appendFileSync(logFile, `${stamp} raccache: rclone stderr: ${stderr}\n`);
  }
  return result.status ?? 1;
}
