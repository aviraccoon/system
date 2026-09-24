/**
 * Journal-fresh gate: a subagent dispatch requires the project journal to have
 * been written since the threshold (session start, or the last real user
 * input). Dir-level newest-entry-mtime is the honest mechanical proxy:
 * per-cited-file freshness would force touching historical entries handed
 * over as background, and corrupting the journal to pass a gate is worse than
 * an under-enforced rule. Multiple entries per session are fine — any fresh
 * top-level entry write clears it.
 *
 * Pure helpers only — no pi imports; session state lives in index.ts.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { JOURNAL_FILE_RE } from "../shared/journal-context";

/**
 * The project journal dir for a session cwd. Worktrees journal under the main
 * project name (.../<project>.worktrees/<branch>/), so the nearest
 * *.worktrees ancestor decides; a plain cwd falls back to notesDir/<basename>.
 */
export function journalDirFor(notesDir: string, cwd: string): string {
  let dir = cwd;
  while (dir !== dirname(dir)) {
    const name = basename(dir);
    if (name.endsWith(".worktrees")) {
      // A bare container (<repo>/.worktrees/<branch>) takes the repo dir's name.
      const stem = name.slice(0, -".worktrees".length) || basename(dirname(dir));
      return join(notesDir, stem);
    }
    dir = dirname(dir);
  }
  return join(notesDir, basename(cwd) || "root");
}

/** Newest journal entry mtime (dated entry files, top level only); null when absent. */
export function newestMtime(dir: string): number | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const entry of entries) {
    if (!entry.isFile() || !JOURNAL_FILE_RE.test(entry.name)) continue;
    try {
      const mtime = statSync(join(dir, entry.name)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // Raced a deletion mid-scan — the next dispatch re-checks.
    }
  }
  return newest;
}

/** True when the journal dir holds a top-level entry written at or after the threshold. */
export function journalIsCurrent(dir: string, thresholdMs: number): boolean {
  const newest = newestMtime(dir);
  return newest !== null && newest >= thresholdMs;
}
