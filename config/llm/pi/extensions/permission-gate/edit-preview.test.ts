/**
 * Preview summaries: the one-line statement of what a change does, which the
 * permission gate hands to its classifier. A `write` used to be described as an
 * all-additions diff computed from the tool's own content, so a create and an
 * overwrite looked identical — these tests pin the distinction and the counts.
 *
 * Filesystem fixtures, synthetic names, cleaned up per test.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEditPreview, computeWritePreview } from "./edit-preview";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-preview-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("computeWritePreview", () => {
  it("states that the target is created when nothing is there", async () => {
    const dir = tempDir();
    const preview = await computeWritePreview("foo.ts", "alpha\nbeta\n", dir);
    expect(preview.summary).toBe("creates a new file: 2 lines");
    expect(preview.diff).toContain("+1 alpha");
    expect(preview.diff).not.toContain("-1");
  });

  it("states what an overwrite removes and adds", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "foo.ts"), "alpha\nbeta\ngamma\n");
    const preview = await computeWritePreview("foo.ts", "alpha\nBETA\ngamma\n", dir);
    expect(preview.summary).toBe("overwrites the existing file: removes 1 line, adds 1 line");
    expect(preview.diff).toContain("-2 beta");
    expect(preview.diff).toContain("+2 BETA");
  });

  it("counts a full replacement", async () => {
    const dir = tempDir();
    const old = `${Array.from({ length: 40 }, (_, i) => `old ${i}`).join("\n")}\n`;
    writeFileSync(join(dir, "foo.ts"), old);
    const preview = await computeWritePreview("foo.ts", "new\n", dir);
    expect(preview.summary).toBe("overwrites the existing file: removes 40 lines, adds 1 line");
  });

  it("describes a truncation to empty as an overwrite that removes every line", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "foo.ts"), "alpha\nbeta\n");
    const preview = await computeWritePreview("foo.ts", "", dir);
    expect(preview.summary).toBe("overwrites the existing file: removes 2 lines, adds 0 lines");
    expect(preview.diff).toContain("-1 alpha");
    expect(preview.diff).not.toContain("+1");
  });

  it("does not claim a new file when the target exists but cannot be read", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "adir"));
    const preview = await computeWritePreview("adir", "x", dir);
    expect(preview.summary).toBe("overwrites an unreadable existing file (EISDIR)");
  });

  it("resolves the path against the cwd and strips a leading @", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "foo.ts"), "one\n");
    const preview = await computeWritePreview("@foo.ts", "one\ntwo\n", dir);
    expect(preview.summary).toBe("overwrites the existing file: removes 0 lines, adds 1 line");
  });
});

describe("computeEditPreview", () => {
  it("summarizes the edit's removals and additions", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "foo.ts"), "keep\nold\nkeep\n");
    const result = await computeEditPreview("foo.ts", [{ oldText: "old", newText: "new" }], dir);
    if ("error" in result) throw new Error(result.error);
    expect(result.summary).toBe("edits the existing file: removes 1 line, adds 1 line");
  });
});
