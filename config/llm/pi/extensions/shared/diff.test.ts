import { describe, expect, test } from "bun:test";
import { changedLineNumbers, diffLineCounts, diffRunes, pluralLines } from "./diff";

describe("changedLineNumbers", () => {
  test("identical content → []", () => {
    expect(changedLineNumbers("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
  });

  test("empty both → []", () => {
    expect(changedLineNumbers("", "")).toEqual([]);
  });

  test("substitution of one line mid-file → that line only", () => {
    expect(changedLineNumbers("a\nb\nc\nd\n", "a\nb\nX\nd\n")).toEqual([3]);
  });

  test("change at the very start", () => {
    expect(changedLineNumbers("a\nb\n", "A\nb\n")).toEqual([1]);
  });

  test("change at the very end", () => {
    expect(changedLineNumbers("a\nb\nc\n", "a\nb\nC\n")).toEqual([3]);
  });

  test("trailing-newline-only difference is treated as identical", () => {
    // splitLines drops the trailing empty, so old and new have the same lines.
    expect(changedLineNumbers("a\nb", "a\nb\n")).toEqual([]);
  });

  test("insertion of a line returns the inserted line", () => {
    expect(changedLineNumbers("a\nb\nc\n", "a\nb\nc\nd\n")).toEqual([4]);
  });

  test("insertion in the middle reports the inserted line", () => {
    expect(changedLineNumbers("a\nb\nd\n", "a\nb\nc\nd\n")).toEqual([3]);
  });

  test("substitution with a shared prefix/suffix trims around the middle", () => {
    expect(changedLineNumbers("x\ny\np\nq\nz\nw\n", "x\ny\nP\nQ\nz\nw\n")).toEqual([3, 4]);
  });
});

describe("diffRunes", () => {
  test("identical → []", () => {
    expect(diffRunes("hello", "hello")).toEqual([]);
  });

  test("single substituted rune", () => {
    expect(diffRunes("abc", "axc")).toEqual([{ expected: "b", actual: "x" }]);
  });

  test("pure insertion", () => {
    expect(diffRunes("ab", "aXb")).toEqual([{ expected: "", actual: "X" }]);
  });

  test("adjacent del+ins coalesces into one substitution hunk", () => {
    expect(diffRunes("abc", "adc")).toEqual([{ expected: "b", actual: "d" }]);
  });

  test("empty input side", () => {
    expect(diffRunes("", "abc")).toEqual([{ expected: "", actual: "abc" }]);
    expect(diffRunes("abc", "")).toEqual([{ expected: "abc", actual: "" }]);
  });

  test("long lines fall back to prefix/suffix span (bounded LCS)", () => {
    const a = "aaaa".repeat(120); // > MAX_LCS_LEN (400)
    const b = "aaabaa".repeat(120);
    const hunks = diffRunes(a, b);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].expected).not.toBe(hunks[0].actual);
  });
});

describe("diffLineCounts", () => {
  test("counts by each line's own marker", () => {
    expect(diffLineCounts("-1 old\n+1 new\n 2 kept\n+3 added")).toEqual({ added: 2, removed: 1 });
  });

  test("a content line that starts with a marker after its line number is counted by the marker", () => {
    expect(diffLineCounts("+1 ++i\n-1 --i")).toEqual({ added: 1, removed: 1 });
  });

  test("empty diff → zeros", () => {
    expect(diffLineCounts("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("pluralLines", () => {
  test("singular and plural", () => {
    expect(pluralLines(1)).toBe("1 line");
    expect(pluralLines(0)).toBe("0 lines");
    expect(pluralLines(40)).toBe("40 lines");
  });
});
