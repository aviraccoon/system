// Dataless iCloud Drive files. Their content lives only in iCloud, and a
// launchd job cannot materialise one on read: the kernel answers EDEADLK, which
// rclone logs as `read <path>: resource deadlock avoided`. rclone then skips the
// whole delete phase for that target, so the mirror quietly stops converging.
// Asking the CloudDocs daemon for a copy does work from that context, but
// `brctl download` only queues the fetch, so the file has to be polled until it
// reads before the sync is worth retrying.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

/** Source paths rclone reported as unreadable, deduped, in log order. */
export function deadlockPaths(lines: string[]): string[] {
  const paths = new Set<string>();
  for (const line of lines) {
    const match = /: read (.+): resource deadlock avoided$/.exec(line.trim());
    if (match && statSync(match[1], { throwIfNoEntry: false })?.isFile()) paths.add(match[1]);
  }
  return [...paths];
}

/** Reading a byte fails with EDEADLK while the content is still only in iCloud. */
export function readable(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Still waiting on the daemon: the file is there and does not read. A path that
 * has since been deleted is not cloud-only - reporting it as such would hold the
 * pair for the whole deadline and then blame the cloud for it.
 */
function cloudOnly(path: string, isReadable: (path: string) => boolean): boolean {
  return existsSync(path) && !isReadable(path);
}

export interface MaterializeOptions {
  brctl: string;
  env?: NodeJS.ProcessEnv;
  /** How long to wait for the daemon, and how often to look. */
  intervalMs?: number;
  deadlineMs?: number;
  /** Seams for tests; the defaults are the real probes. */
  isReadable?: (path: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MaterializeResult {
  /** Files that were still cloud-only when the fetch was requested. */
  requested: number;
  /** How many of those read afterwards. */
  fetched: number;
  /** Still cloud-only when the deadline passed. */
  pending: string[];
}

export async function materialize(paths: string[], options: MaterializeOptions): Promise<MaterializeResult> {
  const isReadable = options.isReadable ?? readable;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let pending = paths.filter((path) => cloudOnly(path, isReadable));
  const requested = pending.length;
  for (const path of pending) {
    spawnSync(options.brctl, ["download", path], { stdio: "ignore", env: options.env, timeout: 60_000 });
  }
  // The wait starts after the requests: a slow daemon must not eat the poll window.
  const deadline = now() + (options.deadlineMs ?? 300_000);
  while (pending.length > 0 && now() < deadline) {
    await sleep(options.intervalMs ?? 1000);
    pending = pending.filter((path) => cloudOnly(path, isReadable));
  }
  return { requested, fetched: requested - pending.length, pending };
}
