import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispatchRan,
  dispatchTasks,
  type JournalRecord,
  type JournalTarget,
  journalBlockNeeded,
  journalDirFor,
  journalFreshnessBlockReason,
  journalIsCurrent,
  journalLinkBlockReason,
  journalLinked,
  journalParam,
  journalRecord,
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

describe("journalParam", () => {
  /** A tmp notes tree holding one project dir. */
  function notesTree(): { home: string; notes: string; project: string } {
    const home = mkdtempSync(join(tmpdir(), "edit-guard-home-"));
    const notes = join(home, "notes", "journal");
    const project = join(notes, "bar-project");
    mkdirSync(project, { recursive: true });
    return { home, notes, project };
  }

  test("accepts an existing journal dir directly under the notes dir, absolute or ~-prefixed", () => {
    const { home, notes, project } = notesTree();
    expect(journalParam(project, notes)).toEqual({ kind: "dir", dir: project });
    expect(journalParam("~/notes/journal/bar-project", notes, home)).toEqual({ kind: "dir", dir: project });
  });

  test("treats absent, none, empty, and non-strings", () => {
    expect(journalParam(undefined, "/notes")).toEqual({ kind: "absent" });
    expect(journalParam("none", "/notes")).toEqual({ kind: "none" });
    expect(journalParam(" none ", "/notes")).toEqual({ kind: "none" });
    expect(journalParam("  ", "/notes").kind).toBe("invalid");
    expect(journalParam(7, "/notes").kind).toBe("invalid");
  });

  test("rejects relative, outside-notes, notes-dir, and missing paths", () => {
    const { home, notes } = notesTree();
    expect(journalParam("notes/journal/bar-project", notes).kind).toBe("invalid");
    expect(journalParam(join(home, "elsewhere"), notes).kind).toBe("invalid");
    expect(journalParam(notes, notes).kind).toBe("invalid");
    expect(journalParam(join(notes, "no-such-project"), notes).kind).toBe("invalid");
  });

  test("rejects a loose file directly under the notes dir", () => {
    const { notes } = notesTree();
    const file = write(notes, "release-notes.md", 1_000);
    const param = journalParam(file, notes);
    expect(param.kind).toBe("invalid");
    expect(param.kind === "invalid" ? param.reason : "").toContain("not a journal dir");
  });

  test("accepts an existing entry file", () => {
    const { notes, project } = notesTree();
    const entry = write(project, "2026-01-01-01-entry.md", 1_000);
    expect(journalParam(entry, notes)).toEqual({ kind: "entry", file: entry });
  });

  test("rejects missing, non-entry, and nested files", () => {
    const { notes, project } = notesTree();
    write(project, "2026-01-01-01-entry.md", 1_000);
    expect(journalParam(write(project, "TODO.md", 1_000), notes).kind).toBe("invalid");
    expect(journalParam(join(project, "2026-01-02-01-missing.md"), notes).kind).toBe("invalid");
    expect(journalParam(join(project, "sub", "2026-01-01-01-entry.md"), notes).kind).toBe("invalid");
  });

  test("rejects a directory named like an entry", () => {
    const { notes, project } = notesTree();
    const fake = join(project, "2026-01-01-01-fake.md");
    mkdirSync(fake);
    expect(journalParam(fake, notes).kind).toBe("invalid");
  });
});

describe("journalRecord", () => {
  test("a dir target is current when its newest entry is at or after the threshold", () => {
    const notes = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    const project = join(notes, "bar-project");
    write(project, "2026-01-01-01-entry.md", 5_000);
    const record = journalRecord({ kind: "dir", dir: project }, "/session", 5_000);
    expect(record).toEqual({
      key: project,
      current: true,
      subject: `the journal (${project})`,
      update: "Update the journal to the current state",
    });
    expect(journalRecord({ kind: "dir", dir: project }, "/session", 5_001)?.current).toBe(false);
  });

  test("an entry target is checked by its own mtime, not the dir's", () => {
    const notes = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    const project = join(notes, "bar-project");
    const old = write(project, "2026-01-01-01-old.md", 1_000);
    const fresh = write(project, "2026-01-01-02-new.md", 9_000);
    const record = journalRecord({ kind: "entry", file: old }, "/session", 5_000);
    expect(record).toEqual({
      key: old,
      current: false,
      subject: `the entry (${old})`,
      update: "Write the named entry with the current state (or pass a fresh entry)",
    });
    expect(journalRecord({ kind: "entry", file: fresh }, "/session", 5_000)?.current).toBe(true);
  });

  test("a missing entry file is not current", () => {
    const notes = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    const missing = join(notes, "bar-project", "2026-01-01-01-gone.md");
    expect(journalRecord({ kind: "entry", file: missing }, "/session", 0)?.current).toBe(false);
  });

  test("absent falls back to the session journal", () => {
    const notes = mkdtempSync(join(tmpdir(), "edit-guard-notes-"));
    const session = join(notes, "session-project");
    write(session, "2026-01-01-01-entry.md", 5_000);
    expect(journalRecord({ kind: "absent" }, session, 5_000)).toEqual({
      key: session,
      current: true,
      subject: `the journal (${session})`,
      update: "Update the journal to the current state",
    });
    expect(journalRecord({ kind: "absent" }, session, 9_000)?.current).toBe(false);
  });

  test("the none opt-out has no record to guard", () => {
    expect(journalRecord({ kind: "none" }, "/session", 0)).toBeNull();
  });
});

describe("journalBlockNeeded", () => {
  const stale: JournalRecord = {
    key: "/record",
    current: false,
    subject: "the journal (/record)",
    update: "Update the journal to the current state",
  };

  test("blocks a stale record no previous block covered", () => {
    expect(journalBlockNeeded(stale, null)).toBe(true);
    expect(journalBlockNeeded(stale, "/other-record")).toBe(true);
  });

  test("passes a current record or one a previous block covered", () => {
    expect(journalBlockNeeded({ ...stale, current: true }, null)).toBe(false);
    expect(journalBlockNeeded(stale, "/record")).toBe(false);
  });
});

describe("journalFreshnessBlockReason", () => {
  test("names the record and the remedy", () => {
    const entry = journalFreshnessBlockReason({
      key: "/e",
      current: false,
      subject: "the entry (/e)",
      update: "Write the named entry with the current state (or pass a fresh entry)",
    });
    expect(entry).toContain("the entry (/e)");
    expect(entry).toContain("Write the named entry");
    const dir = journalFreshnessBlockReason({
      key: "/d",
      current: false,
      subject: "the journal (/d)",
      update: "Update the journal to the current state",
    });
    expect(dir).toContain("Update the journal");
    expect(dir).toContain("no write newer");
  });
});

describe("journalLinkBlockReason", () => {
  const dir = "/Users/foo/notes/journal/bar-project";
  const absent: JournalTarget = { kind: "absent" };

  test("returns null when every task links the journal", () => {
    expect(journalLinkBlockReason({ task: `Read ${dir} first, then review` }, dir, absent)).toBeNull();
    expect(
      journalLinkBlockReason(
        {
          tasks: [
            { agent: "a", task: `Read ${dir} first` },
            { agent: "b", task: `See ${dir}/TODO.md` },
          ],
        },
        dir,
        absent,
      ),
    ).toBeNull();
  });

  test("returns null for the param forms", () => {
    expect(journalLinkBlockReason({ task: "blind review" }, dir, { kind: "none" })).toBeNull();
    expect(journalLinkBlockReason({ task: "blind review" }, dir, { kind: "dir", dir })).toBeNull();
    expect(
      journalLinkBlockReason({ task: "blind review" }, dir, {
        kind: "entry",
        file: `${dir}/2026-01-01-01-entry.md`,
      }),
    ).toBeNull();
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
      absent,
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
