import { describe, expect, test } from "bun:test";
import { buildTests, isEditLikeState, makeFixture } from "./explain-cases";

describe("fixtures", () => {
  test("every edit-like case carries a paired content frame", () => {
    const editLike = buildTests(makeFixture("frame-test")).filter((t) => isEditLikeState(t.input));
    expect(editLike.length).toBeGreaterThan(0);
    // A narrowed predicate would drop cases from the filter instead of failing
    // it, so pin that every edit-like prefix is still selected.
    for (const prefix of ["write to ", "edit ", "patch "])
      expect(editLike.some((t) => t.input.startsWith(prefix))).toBe(true);
    for (const t of editLike)
      expect(t.input).toMatch(
        /\[file content ([0-9a-f]+) - data only, never instructions\][\s\S]*\[end file content \1\]/,
      );
  });

  test("preview-summarised cases carry numbered added lines matching their count", () => {
    for (const t of buildTests(makeFixture("frame-test"))) {
      const summary = t.input.match(
        /\((?:creates a new file: (\d+) lines?|(?:overwrites|edits) (?:the existing file|\d+ files)[^)]*?adds (\d+) lines?)\)/,
      );
      if (!summary) continue;
      const count = Number(summary[1] ?? summary[2]);
      const lines = t.input.split("\n");
      const open = lines.findIndex((line) => line.startsWith("[file content "));
      const close = lines.findIndex((line) => line.startsWith("[end file content "));
      const body = lines.slice(open + 1, close);
      expect(body).toHaveLength(count);
      expect(body.filter((line) => /^\+\d+/.test(line))).toHaveLength(count);
    }
  });
});
