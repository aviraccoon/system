/**
 * Journal gate: a subagent dispatch requires the project journal to have been
 * written since the threshold (session start, re-armed by every real user
 * input and every concluded dispatch where a child ran). Dir-level
 * newest-entry-mtime is the honest mechanical proxy: per-cited-file freshness
 * would force touching historical entries handed over as background, and
 * corrupting the journal to pass a gate is worse than an under-enforced rule.
 * Multiple entries per session are fine — any fresh top-level entry write
 * clears it. The dispatch must also link the journal (below), so the child
 * can read the record.
 *
 * Pure helpers only — no pi imports; session state lives in index.ts.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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

/** True when the task text links the journal: contains the journal dir path,
 * absolute or ~-prefixed. A link to an entry under the dir contains the dir
 * as a prefix, so it counts. Only concrete paths count — "read the journal"
 * without a path leaves the child unable to find it. `home` defaults to the
 * real homedir; tests pass a synthetic one. The matched path must not be a
 * mere prefix of a longer segment ("…/llm/system" vs "…/llm/systematic"). */
export function journalLinked(task: string, journalDir: string, home: string = homedir()): boolean {
  if (mentionsPath(task, journalDir)) return true;
  if (journalDir.startsWith(`${home}/`)) {
    return mentionsPath(task, `~/${relative(home, journalDir)}`);
  }
  return false;
}

/** True when `path` occurs in `text` followed by end-of-string or a character
 * that can't extend a path segment (anything but [a-zA-Z0-9_-]). */
function mentionsPath(text: string, path: string): boolean {
  let i = text.indexOf(path);
  while (i !== -1) {
    const next = text[i + path.length];
    if (next === undefined || !/[a-zA-Z0-9_-]/.test(next)) return true;
    i = text.indexOf(path, i + 1);
  }
  return false;
}

/** Task texts of a subagent dispatch, across all three modes, labeled so a
 * block can name the offending tasks. */
export interface DispatchTask {
  label: string;
  task: string;
}

export function dispatchTasks(input: Record<string, unknown>): DispatchTask[] {
  const out: DispatchTask[] = [];
  if (typeof input.task === "string") out.push({ label: "task", task: input.task });
  for (const key of ["tasks", "chain"]) {
    const list = input[key];
    if (Array.isArray(list)) {
      list.forEach((item, i) => {
        const record = item as { task?: unknown; agent?: unknown } | null;
        if (typeof record?.task === "string") {
          const agent = typeof record.agent === "string" ? ` (${record.agent})` : "";
          out.push({ label: `${key}[${i}]${agent}`, task: record.task });
        }
      });
    }
  }
  return out;
}

/** Block reason when the dispatch does not link the journal; null when it
 * opts out via `journal: "none"` or every task carries the path. Stateless —
 * every unlinked dispatch blocks; the opt-out is the param, not a re-issue
 * escape (a block-once flag would let a second concurrent dispatch in the
 * same turn sail through after the first was blocked). */
export function journalLinkBlockReason(input: Record<string, unknown>, journalDir: string): string | null {
  if (input.journal === "none") return null;
  const unlinked = dispatchTasks(input).filter((t) => !journalLinked(t.task, journalDir));
  if (unlinked.length === 0) return null;
  const labels = unlinked.map((t) => t.label).join(", ");
  return (
    `edit-guard: dispatch blocked — ${unlinked.length === 1 ? "a task does" : "tasks do"} not link ` +
    `the project journal (${journalDir}): ${labels}. Include the journal path in each listed task ` +
    "and tell the agent to read it, so the child starts from the current record. If a task " +
    "deliberately runs without journal context (blind review, throwaway lookup), pass journal: " +
    '"none" on the subagent call — it exempts the whole dispatch.'
  );
}

/** True when a subagent tool result represents a dispatch that returned
 * children — success or failure. No-op declines (invalid parameters, a
 * disabled tool, a canceled confirm) carry empty or absent results, and an
 * aborted dispatch throws (details-less error), so neither re-arms the
 * freshness cycle. */
export function dispatchRan(details: unknown): boolean {
  const results = (details as { results?: unknown } | null)?.results;
  return Array.isArray(results) && results.length > 0;
}
