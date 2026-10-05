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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/**
 * What the dispatch's `journal` param names. A `dir` target is read through
 * its TODO.md and newest entries; an `entry` target is one file inside a
 * journal dir.
 */
export type JournalParam =
  | { kind: "absent" }
  | { kind: "none" }
  | { kind: "dir"; dir: string }
  | { kind: "entry"; file: string }
  | { kind: "invalid"; reason: string };

/** "dir" | "file" | "missing" for a path; symlinks followed. */
function pathKind(path: string): "dir" | "file" | "missing" {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/**
 * Classify the `journal` param. Only absolute and ~-prefixed paths are
 * accepted: a task's cwd can differ from the session's, so a relative path
 * need not resolve for the child. A named path must be an existing journal dir
 * directly under notesDir or an existing entry file inside one, so a typo is
 * caught here rather than by a child that reads nothing. `home` is
 * parametrized for tests.
 */
export function journalParam(value: unknown, notesDir: string, home: string = homedir()): JournalParam {
  if (value === undefined) return { kind: "absent" };
  if (typeof value !== "string") {
    return { kind: "invalid", reason: 'journal param must be "none" or a journal path' };
  }
  const raw = value.trim();
  if (raw === "none") return { kind: "none" };
  if (raw === "") {
    return { kind: "invalid", reason: 'journal param must be "none" or a journal path' };
  }
  const abs =
    raw === "~" ? home : raw.startsWith("~/") ? resolve(home, raw.slice(2)) : isAbsolute(raw) ? resolve(raw) : null;
  if (abs === null) {
    return { kind: "invalid", reason: `journal param must be an absolute or ~-prefixed path (got "${raw}")` };
  }
  const notes = resolve(notesDir);
  if (dirname(abs) === notes) {
    const kind = pathKind(abs);
    if (kind !== "dir") {
      return {
        kind: "invalid",
        reason: `journal param names ${kind === "file" ? "a file, not a journal dir" : "no journal dir"} (${abs})`,
      };
    }
    return { kind: "dir", dir: abs };
  }
  if (dirname(dirname(abs)) === notes) {
    if (!JOURNAL_FILE_RE.test(basename(abs))) {
      return {
        kind: "invalid",
        reason: `journal param must be a journal dir or an entry file under ${notes} (got ${abs})`,
      };
    }
    const kind = pathKind(abs);
    if (kind !== "file") {
      return {
        kind: "invalid",
        reason: `journal param names ${kind === "dir" ? "a directory, not an entry" : "a missing entry"} (${abs})`,
      };
    }
    return { kind: "entry", file: abs };
  }
  return { kind: "invalid", reason: `journal param must be a journal dir or an entry under ${notes} (got ${abs})` };
}

/** A param that reaches the gate's decisions: `none` names no record to
 * guard, `absent` falls back to the session journal. Invalid params are
 * blocked before these run. */
export type JournalTarget = Extract<JournalParam, { kind: "absent" | "none" | "dir" | "entry" }>;

/** A dispatch's freshness state: the record it reads — the param's target or
 * the session journal — whether that record has a write at or after the
 * threshold, and the phrases a block message needs. The key is the record
 * itself, so a freshness block on one journal does not waive a later dispatch
 * that names another. */
export interface JournalRecord {
  key: string;
  current: boolean;
  subject: string;
  /** What clearing the block requires. */
  update: string;
}

/** True when the file's mtime is at or after the threshold; a missing or
 * unreadable file is not current. */
function fileIsCurrent(file: string, thresholdMs: number): boolean {
  try {
    return statSync(file).mtimeMs >= thresholdMs;
  } catch {
    return false;
  }
}

/** The record a dispatch reads, or null when there is nothing to guard: the
 * `none` opt-out runs without journal context, so neither freshness nor the
 * link applies. A named entry is checked by its own mtime; a dir or the
 * session journal by its newest entry. */
export function journalRecord(param: JournalTarget, sessionDir: string, thresholdMs: number): JournalRecord | null {
  if (param.kind === "none") return null;
  if (param.kind === "entry") {
    return {
      key: param.file,
      current: fileIsCurrent(param.file, thresholdMs),
      subject: `the entry (${param.file})`,
      update: "Write the named entry with the current state (or pass a fresh entry)",
    };
  }
  const dir = param.kind === "dir" ? param.dir : sessionDir;
  return {
    key: dir,
    current: journalIsCurrent(dir, thresholdMs),
    subject: `the journal (${dir})`,
    update: "Update the journal to the current state",
  };
}

/** Whether a freshness block issues for this record: not one a previous block
 * covered, and not current. */
export function journalBlockNeeded(record: JournalRecord, openedKey: string | null): boolean {
  return openedKey !== record.key && !record.current;
}

/** Block reason when the record a dispatch reads has no fresh write. */
export function journalFreshnessBlockReason(record: JournalRecord): string {
  return (
    `edit-guard: dispatch blocked — ${record.subject} has no write newer than ` +
    `the last user message or completed dispatch. ${record.update} first — ` +
    "findings, decisions, unfinished work so far — then re-dispatch; a subagent must never read " +
    "a stale record. If the user explicitly said to skip journaling, re-issue the identical dispatch."
  );
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

/** Block reason when the dispatch does not link a journal; null when it links
 * one — the `journal` param names a target, opts out with "none", or every
 * task carries the session journal's path. */
export function journalLinkBlockReason(
  input: Record<string, unknown>,
  journalDir: string,
  param: JournalTarget,
  home: string = homedir(),
): string | null {
  if (param.kind === "none" || param.kind === "dir" || param.kind === "entry") return null;
  const unlinked = dispatchTasks(input).filter((t) => !journalLinked(t.task, journalDir, home));
  if (unlinked.length === 0) return null;
  const labels = unlinked.map((t) => t.label).join(", ");
  return (
    `edit-guard: dispatch blocked — ${unlinked.length === 1 ? "a task does" : "tasks do"} not link ` +
    `a journal: ${labels}. Pass journal: "<journal dir or entry>" on the subagent call and the ` +
    `tool tells every child to read it, or include the session journal path (${journalDir}) in ` +
    `each task. Pass journal: "none" only when the dispatch deliberately runs without journal ` +
    "context (blind review, throwaway lookup)."
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
