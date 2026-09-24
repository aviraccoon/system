import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalDirFor, journalIsCurrent, newestMtime } from "./journal-fresh";

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
