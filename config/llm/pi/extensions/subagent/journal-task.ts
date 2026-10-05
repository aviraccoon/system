/**
 * Journal context for dispatches. A `journal` param naming a journal dir or a
 * specific entry makes the tool prepend a read instruction to every task, so
 * the task text need not repeat the path. edit-guard reads the same param as
 * the dispatch's journal link; this preamble is what makes that link real — a
 * child runs with PI_SUBAGENT=1 and gets no journal context of its own.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

/** The `journal` param's path (absolute; a leading ~ is expanded), or null when
 * absent, the "none" opt-out, or not a path the child can resolve — a relative
 * path is not, since a task's cwd can differ from the session's. */
export function journalPath(value: unknown, home: string = homedir()): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "" || raw === "none") return null;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return resolve(home, raw.slice(2));
  return isAbsolute(raw) ? raw : null;
}

/** True when the target is an existing directory: a journal read through its
 * TODO.md and newest entries. Any other target reads as one record. */
function isJournalDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Prepended to every task of a journaled dispatch. The TODO.md path is spelled
 * out — children otherwise look for it in the working directory. */
export function journalPreamble(journal: string): string {
  return isJournalDir(journal)
    ? `Journal: read ${journal}/TODO.md and the newest entries in ${journal} before starting — they ` +
        "hold the current state and prior decisions."
    : `Journal: read ${journal} before starting — it holds the context and decisions for this dispatch; ` +
        `open items are in ${dirname(journal)}/TODO.md.`;
}

/** The task as the child receives it. */
export function withJournalContext(task: string, journal: string): string {
  return `${journalPreamble(journal)}\n\n${task}`;
}

/** The task as the child receives it: the journal preamble prepended when the
 * dispatch names a journal. */
export function taskForChild(task: string, journal: string | null): string {
  return journal === null ? task : withJournalContext(task, journal);
}
