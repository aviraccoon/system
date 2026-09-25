import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchRan,
  dispatchTasks,
  journalDirFor,
  journalIsCurrent,
  journalLinkBlockReason,
  journalLinked,
  newestMtime,
} from "./journal-fresh";

function write(dir: string, name: string, mtimeMs: number): string {
  const file = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "entry");
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

/** A journal-shaped project dir: notesDir/<name>/ holding one entry. */
function projectDir(notesDir: string, name: string, mtimeMs: number): string {
  const dir = join(notesDir, name);
  mkdirSync(dir, { recursive: true });
  write(dir, "2026-01-01-01-entry.md", mtimeMs);
  return dir;
}

describe("newestMtime", () => {
  test("takes the newest top-level entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-guard-jf-"));
    write(dir, "2026-01-01-01-a.md", 1_000);
    write(dir, "2026-01-01-02-b.md", 2_000);
    expect(newestMtime(dir)).toBe(2_000);
  });

  test("ignores subdirectories and non-entry files", () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-guard-jf-"));
    write(dir, "2026-01-01-01-a.md", 1_000);
    write(join(dir, "release-notes"), "note.md", 9_000);
    write(dir, "meta.json", 9_000);
    write(dir, "TODO.md", 9_000);
    expect(newestMtime(dir)).toBe(1_000);
  });

  test("missing or empty dir → null", () => {
    expect(newestMtime(join(tmpdir(), "edit-guard-missing-dir"))).toBe(null);
    expect(newestMtime(mkdtempSync(join(tmpdir(), "edit-guard-jf-")))).toBe(null);
  });
});

describe("journalIsCurrent", () => {
  test("a write at or after the threshold passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-guard-jf-"));
    write(dir, "2026-01-01-01-a.md", 5_000);
    expect(journalIsCurrent(dir, 5_000)).toBe(true);
    expect(journalIsCurrent(dir, 5_001)).toBe(false);
  });

  test("multiple entries: any fresh write clears it", () => {
    const dir = mkdtempSync(join(tmpdir(), "edit-guard-jf-"));
    write(dir, "2026-01-01-01-a.md", 1_000);
    write(dir, "2026-01-01-02-b.md", 9_000);
    expect(journalIsCurrent(dir, 5_000)).toBe(true);
  });

  test("a missing journal dir never counts as current", () => {
    expect(journalIsCurrent(join(tmpdir(), "edit-guard-missing-dir"), 0)).toBe(false);
  });
});

describe("journalDirFor", () => {
  test("uses the cwd basename for a plain project path", () => {
    const notesDir = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    const dir = projectDir(notesDir, "bar-project", 1_000);
    expect(journalDirFor(notesDir, "/Users/foo/code/bar-project")).toBe(dir);
  });

  test("resolves a worktree to the main project via the .worktrees ancestor", () => {
    const notesDir = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    const dir = projectDir(notesDir, "bar-project", 1_000);
    projectDir(notesDir, "system", 1_000); // a branch dir that collides with another project
    const worktree = "/Users/foo/code/bar-project.worktrees/feat/system";
    expect(journalDirFor(notesDir, worktree)).toBe(dir);
  });

  test("resolves a cwd under a bare .worktrees container to the repo dir", () => {
    const notesDir = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    const dir = projectDir(notesDir, "bar-project", 1_000);
    expect(journalDirFor(notesDir, "/Users/foo/code/bar-project/.worktrees/feat/x")).toBe(dir);
  });

  test("falls back to the basename dir when nothing matches", () => {
    const notesDir = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    expect(journalDirFor(notesDir, "/Users/foo/code/new-project")).toBe(join(notesDir, "new-project"));
  });

  test("names the root project when cwd has no basename", () => {
    const notesDir = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    expect(journalDirFor(notesDir, "/")).toBe(join(notesDir, "root"));
  });
});

describe("journalLinked", () => {
  const journalDir = "/Users/foo/notes/journal/bar-project";

  test("accepts the absolute dir path", () => {
    expect(journalLinked("Read /Users/foo/notes/journal/bar-project first, then review", journalDir)).toBe(true);
  });

  test("accepts a link to an entry under the dir", () => {
    expect(
      journalLinked("Read /Users/foo/notes/journal/bar-project/2026-01-01-01-entry.md for context", journalDir),
    ).toBe(true);
  });

  test("accepts the ~-prefixed form", () => {
    expect(journalLinked("Read ~/notes/journal/bar-project/TODO.md for open items", journalDir, "/Users/foo")).toBe(
      true,
    );
  });

  test("rejects a ~-form when the dir is not under the home", () => {
    expect(journalLinked("Read ~/somewhere/bar-project first", journalDir, "/Users/foo")).toBe(false);
  });

  test("rejects a dispatch with no journal path", () => {
    expect(journalLinked("Review the staged diff", journalDir)).toBe(false);
  });

  test("rejects a different project's journal", () => {
    expect(journalLinked("Read /Users/foo/notes/journal/other-project first", journalDir)).toBe(false);
  });

  test("rejects prose that mentions the journal without a path", () => {
    expect(journalLinked("Check the journal for prior decisions", journalDir)).toBe(false);
  });

  test("paths with spaces match", () => {
    const spaced = "/Users/foo/My Notes/journal/bar-project";
    expect(journalLinked("Read /Users/foo/My Notes/journal/bar-project first", spaced)).toBe(true);
  });

  test("rejects a sibling dir that shares the path prefix", () => {
    expect(journalLinked("Read /Users/foo/notes/journal/systematic-notes.md first", journalDir)).toBe(false);
    expect(journalLinked("Read /Users/foo/notes/journal/system-extra first", journalDir)).toBe(false);
  });

  test("accepts the dir followed by punctuation (sentence end)", () => {
    const sysDir = "/Users/foo/notes/journal/system";
    expect(journalLinked("Read /Users/foo/notes/journal/system.", sysDir)).toBe(true);
  });
});

describe("dispatchTasks", () => {
  test("reads all three modes", () => {
    const single = dispatchTasks({ task: "one" });
    expect(single.map((t) => t.label)).toEqual(["task"]);
    const parallel = dispatchTasks({
      tasks: [
        { agent: "a", task: "t1" },
        { agent: "b", task: "t2" },
      ],
    });
    expect(parallel.map((t) => t.label)).toEqual(["tasks[0] (a)", "tasks[1] (b)"]);
    const chain = dispatchTasks({ chain: [{ agent: "c", task: "t3" }] });
    expect(chain.map((t) => t.label)).toEqual(["chain[0] (c)"]);
  });

  test("malformed input yields no tasks", () => {
    expect(dispatchTasks({})).toEqual([]);
    expect(dispatchTasks({ tasks: [null, 3] })).toEqual([]);
  });
});

describe("journalLinkBlockReason", () => {
  const dir = "/Users/foo/notes/journal/bar-project";

  test("returns null when every task links the journal", () => {
    expect(journalLinkBlockReason({ task: `Read ${dir} first, then review` }, dir)).toBeNull();
    expect(
      journalLinkBlockReason(
        {
          tasks: [
            { agent: "a", task: `Read ${dir} first` },
            { agent: "b", task: `See ${dir}/TODO.md` },
          ],
        },
        dir,
      ),
    ).toBeNull();
  });

  test("returns null when the dispatch opts out via the param", () => {
    expect(journalLinkBlockReason({ task: "blind review", journal: "none" }, dir)).toBeNull();
  });

  test("names the unlinked tasks", () => {
    const reason = journalLinkBlockReason(
      {
        tasks: [
          { agent: "reviewer", task: `Read ${dir} first` },
          { agent: "fixer", task: "apply fixes" },
        ],
      },
      dir,
    );
    expect(reason).toContain("a task does not link");
    expect(reason).toContain("tasks[1] (fixer)");
  });
});

describe("dispatchRan", () => {
  test("a result with children re-arms", () => {
    expect(dispatchRan({ results: [{}] })).toBe(true);
  });

  test("no-op declines and absent details do not", () => {
    expect(dispatchRan(undefined)).toBe(false);
    expect(dispatchRan({})).toBe(false);
    expect(dispatchRan({ results: [] })).toBe(false);
  });
});
