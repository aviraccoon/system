// Single-run lock. A scheduled run that fires while the previous one is still
// uploading must skip, and a lock left behind by a killed process must be
// reclaimable without two starters winning the same reclaim.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** A lock with no pid file younger than this counts as live. */
  staleAfterMs?: number;
}

export interface LockResult {
  acquired: boolean;
  reason?: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(dir: string, options: LockOptions = {}): LockResult {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 120_000;

  const take = (): LockResult => {
    mkdirSync(dir);
    writeFileSync(join(dir, "pid"), `${pid}\n`);
    return { acquired: true };
  };

  try {
    return take();
  } catch {
    // fall through to the stale checks
  }

  const lockPid = (() => {
    try {
      return readFileSync(join(dir, "pid"), "utf8").trim();
    } catch {
      return "";
    }
  })();
  const age = now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? 0);
  if (lockPid ? isAlive(Number(lockPid)) : age < staleAfterMs) {
    return { acquired: false, reason: `already running (pid ${lockPid || "unknown"})` };
  }

  // Reclaim atomically: only the starter that wins the rename removes the lock.
  const stale = `${dir}.stale.${pid}`;
  try {
    renameSync(dir, stale);
  } catch {
    return { acquired: false, reason: "lost the stale-lock reclaim" };
  }
  rmSync(stale, { recursive: true, force: true });
  try {
    return take();
  } catch {
    return { acquired: false, reason: "lost the lock race" };
  }
}

export function releaseLock(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
