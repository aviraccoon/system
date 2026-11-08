/**
 * Work a session has running in the background, announced so a reader in another
 * extension can tell "done" from "done, but something is still running".
 *
 * The channel is a directory, not a module or an environment variable: extensions
 * are separate jiti instances (a module imported by two of them is two instances),
 * and an environment value has no way to say "one fewer" or to be cleared by the
 * owner when it finishes. One file per unit, written by whoever started it and
 * removed when it ends, means no coordination between producers and no lock.
 *
 * A marker carries no description of the work, only its kind: the reader's output
 * leaves the machine, so the rule about what a push may contain stays in the
 * extension that writes it.
 *
 * Markers are keyed by session and live under `$TMPDIR`, so the OS bounds their
 * life. A unit whose owner died without removing its marker stops counting after
 * `MAX_AGE_MS`; that bound is what keeps a crashed producer from making every
 * later notification in the same session claim work that ended hours ago.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PendingWork {
  /** What kind of work this is, in the singular: `job`, `subagent`. The reader counts and pluralizes. */
  kind: string;
  /** The owner's own id, so a release removes exactly its marker. */
  id: string;
  /** Epoch milliseconds, used for the age bound and for ordering. */
  startedAt: number;
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function pendingWorkDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_PENDING_WORK_DIR ?? path.join(env.TMPDIR || os.tmpdir(), "pi-pending-work");
}

/**
 * A session id is a UUID today, and this module does not rely on that: only word characters and dashes
 * survive, so an id of `..` names a directory rather than the directory above this one.
 */
function sessionDir(session: string, env: NodeJS.ProcessEnv): string {
  return path.join(pendingWorkDir(env), session.replace(/[^\w-]/g, "_"));
}

function markerPath(session: string, id: string, env: NodeJS.ProcessEnv): string {
  return path.join(sessionDir(session, env), `${id.replace(/[^\w.-]/g, "_")}.json`);
}

function isPending(value: unknown): value is PendingWork {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string" && typeof record.id === "string" && typeof record.startedAt === "number";
}

/**
 * Announce one unit of work and return the release. Never throws: an announcement
 * that cannot be written costs a notification's wording, not the work itself.
 */
export function markPending(
  session: string,
  work: { kind: string; id: string; startedAt?: number },
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const marker = markerPath(session, work.id, env);
  const record: PendingWork = { kind: work.kind, id: work.id, startedAt: work.startedAt ?? Date.now() };
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true, mode: 0o700 });
    // Written beside its name and renamed into place: a reader that waited for a partial write would
    // see invalid JSON, and it deletes what it cannot parse.
    const staging = `${marker}.tmp`;
    fs.writeFileSync(staging, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    fs.renameSync(staging, marker);
  } catch {
    return () => {};
  }
  return () => {
    try {
      fs.rmSync(marker, { force: true });
    } catch {
      /* a marker another reader has open stays until it is not */
    }
  };
}

/**
 * The session's running work, newest first. A marker that cannot be parsed, or
 * that is older than the age bound, is skipped and deleted: a reader must not be
 * the thing that keeps a dead announcement alive.
 */
export function listPending(session: string, env: NodeJS.ProcessEnv = process.env): PendingWork[] {
  const dir = sessionDir(session, env);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const pending: PendingWork[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    let record: unknown;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      rm(file);
      continue;
    }
    if (!isPending(record) || now - record.startedAt > MAX_AGE_MS) {
      rm(file);
      continue;
    }
    pending.push(record);
  }
  return pending.sort((a, b) => b.startedAt - a.startedAt);
}

function rm(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort, like every deletion of a temporary record */
  }
}
