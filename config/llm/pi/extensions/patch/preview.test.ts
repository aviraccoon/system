/**
 * Patch preview summary: the one-line statement of what a patch call does, which
 * the permission gate hands to its classifier. The counts are per file, summed —
 * the joined multi-file diff carries `--- path ---` separators, which a naive
 * count over the joined string would read as removed lines.
 *
 * Filesystem fixtures, synthetic names, cleaned up per test.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computePatchPreview } from "./preview";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "patch-preview-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("computePatchPreview summary", () => {
  it("counts a single-file edit", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "foo.ts"), "keep\nold\nkeep\n");
    const preview = await computePatchPreview("foo.ts", [{ oldText: "old", newText: "new" }], dir);
    expect(preview?.summary).toBe("edits the existing file: removes 1 line, adds 1 line");
  });

  it("aggregates across files without counting the separator as a removal", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "foo.ts"), "one\ntwo\n");
    writeFileSync(join(dir, "bar.ts"), "three\nfour\n");
    const preview = await computePatchPreview(
      "foo.ts",
      [
        { oldText: "one", newText: "ONE" },
        { oldText: "three", newText: "THREE", path: "bar.ts" },
      ],
      dir,
    );
    expect(preview?.summary).toBe("edits 2 files: removes 2 lines, adds 2 lines");
  });
});
