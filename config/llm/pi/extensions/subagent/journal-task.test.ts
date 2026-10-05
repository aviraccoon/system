import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { journalLinked } from "../edit-guard/journal-fresh";
import { journalPath, journalPreamble, taskForChild, withJournalContext } from "./journal-task";

/** A tmp journal dir holding one named entry file. */
function projectWithEntry(name = "2026-01-01-01-entry.md"): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), "subagent-journal-"));
  const entry = join(dir, name);
  writeFileSync(entry, "entry");
  return { dir, entry };
}

describe("journalPath", () => {
  test("returns an absolute path, expanding ~", () => {
    expect(journalPath("/Users/foo/notes/llm/system")).toBe("/Users/foo/notes/llm/system");
    expect(journalPath("  ~/notes/llm/system  ", "/Users/foo")).toBe("/Users/foo/notes/llm/system");
    expect(journalPath("~", "/Users/foo")).toBe("/Users/foo");
  });

  test("returns null for absent, empty, the opt-out, and relative paths", () => {
    expect(journalPath(undefined)).toBeNull();
    expect(journalPath("none")).toBeNull();
    expect(journalPath("")).toBeNull();
    expect(journalPath("   ")).toBeNull();
    expect(journalPath(42)).toBeNull();
    expect(journalPath("notes/llm/system", "/Users/foo")).toBeNull();
  });
});

describe("journalPreamble", () => {
  test("a dir target names TODO.md and the newest entries under it", () => {
    const { dir } = projectWithEntry();
    const preamble = journalPreamble(dir);
    expect(preamble).toContain(`${dir}/TODO.md`);
    expect(preamble).toContain(`the newest entries in ${dir}`);
  });

  test("an entry target names the entry and its journal's TODO.md", () => {
    const { dir, entry } = projectWithEntry();
    const preamble = journalPreamble(entry);
    expect(preamble).toContain(entry);
    expect(preamble).toContain(`${dir}/TODO.md`);
  });

  test("a path that is not an existing dir reads as one record", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-journal-"));
    const missing = join(dir, "2026-01-01-01-missing.md");
    expect(journalPreamble(missing)).toContain(missing);
  });

  test("a directory named like an entry still reads as a dir", () => {
    const parent = mkdtempSync(join(tmpdir(), "subagent-journal-"));
    const dir = join(parent, "2026-01-01-01-fake.md");
    mkdirSync(dir);
    expect(journalPreamble(dir)).toContain(`${dir}/TODO.md`);
  });
});

describe("taskForChild", () => {
  test("passes the task through without a journal", () => {
    expect(taskForChild("do the thing", null)).toBe("do the thing");
  });

  test("prepends the preamble when a journal is named", () => {
    const { dir } = projectWithEntry();
    expect(taskForChild("do the thing", dir)).toBe(withJournalContext("do the thing", dir));
  });

  test("the injected task passes edit-guard's own link check", () => {
    const { dir, entry } = projectWithEntry();
    expect(journalLinked(taskForChild("do the thing", dir), dir)).toBe(true);
    expect(journalLinked(taskForChild("do the thing", entry), dir)).toBe(true);
  });
});
