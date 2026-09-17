import { describe, expect, test } from "bun:test";
import { diffRunes } from "../shared/diff";
import {
  type ClosestMatch,
  closestMatches,
  contextLines,
  countApplied,
  describeCharDiff,
  describeDiagnosis,
  detectBoundaryDuplication,
  detectInsertDuplication,
  diagnoseLineDiff,
  findNearMisses,
  formatClosestMatches,
  formatHitsWithContext,
  formatOutcomes,
  numberedLines,
  similarity,
} from "./diagnostics";
import { type MatchHit, type PlannedInsertion, planAll } from "./match";

function hit(line: number, lineCount = 1): MatchHit {
  return { line, lineCount, kind: "exact", fileIndent: "" };
}

function ins(beforeLine: number, newText: string, mode: PlannedInsertion["mode"] = "insertAfter"): PlannedInsertion {
  return { editIndex: 0, beforeLine, newText, anchored: false, mode };
}

// ── similarity ─────────────────────────────────────────────────────────────

describe("similarity", () => {
  test("identical strings score 1", () => {
    expect(similarity("hello world", "hello world")).toBe(1);
  });
  test("whitespace-only difference scores high", () => {
    expect(similarity("foo bar baz", "foo  bar  baz")).toBeGreaterThan(0.9);
  });
  test("unrelated strings score low", () => {
    expect(similarity("completely different", "zzzzzzzzzzzz")).toBeLessThan(0.2);
  });
  test("empty vs non-empty scores 0", () => {
    expect(similarity("", "abc")).toBe(0);
  });
  test("case-insensitive", () => {
    expect(similarity("Hello", "hello")).toBe(1);
  });
});

// ── numberedLines / contextLines ───────────────────────────────────────────

describe("numberedLines", () => {
  test("assigns 1-based numbers", () => {
    expect(numberedLines("a\nb\nc")).toEqual([
      { num: 1, text: "a" },
      { num: 2, text: "b" },
      { num: 3, text: "c" },
    ]);
  });
  test("drops trailing empty line from final newline", () => {
    expect(numberedLines("a\n")).toEqual([{ num: 1, text: "a" }]);
  });
});

describe("contextLines", () => {
  test("returns lines around target with context", () => {
    const content = "l1\nl2\nl3\nl4\nl5";
    const ctx = contextLines(content, 3, 1);
    expect(ctx.map((l) => l.num)).toEqual([2, 3, 4]);
  });
  test("clamps to file bounds", () => {
    const content = "l1\nl2\nl3";
    expect(contextLines(content, 1, 5).map((l) => l.num)).toEqual([1, 2, 3]);
  });
});

// ── closestMatches ─────────────────────────────────────────────────────────

describe("closestMatches", () => {
  test("finds the most similar window", () => {
    const content = "def alpha():\n    pass\ndef beta():\n    return 1";
    const matches = closestMatches(content, "def alpha():\n    pass");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.line).toBe(1);
    expect(matches[0]?.similarity).toBeGreaterThan(0.8);
  });

  test("returns empty when nothing is similar enough", () => {
    const content = "a\nb\nc";
    expect(closestMatches(content, "zzzzzzzzzzz")).toHaveLength(0);
  });

  test("ranks by similarity descending", () => {
    const content = "function foo() {}\nfunction bar() {}\nconst x = 1";
    const matches = closestMatches(content, "function foo() {}", 3);
    if (matches.length >= 2) {
      expect(matches[0]?.similarity).toBeGreaterThanOrEqual(matches[1]?.similarity ?? 0);
    }
  });
});

describe("formatClosestMatches", () => {
  test("handles empty matches", () => {
    const text = formatClosestMatches([]);
    expect(text).toContain("No similar text");
  });
  test("includes percentage and line numbers", () => {
    const content = "function foo() {}\nconst y = 2";
    const matches = closestMatches(content, "function foo() {}");
    const text = formatClosestMatches(matches);
    expect(text).toContain("% similar");
    expect(text).toContain("Lines");
  });
  test("shows structured diagnosis (whitespace vs content)", () => {
    // File uses tabs; oldText uses spaces — content identical, whitespace differs.
    const content = "\tfoo()\n\tbar()";
    const matches = closestMatches(content, "  foo()\n  bar()");
    const text = formatClosestMatches(matches);
    expect(text).toContain("whitespace");
    expect(text).toContain("content looks right");
  });
  test("enriched output includes per-line codepoint breakdown", () => {
    // oldText has ASCII 'x'; file has U+00D7 MULTIPLICATION SIGN.
    // Exact match fails (normalization: ×→*, not x), closestMatch fires.
    const content = "const area = 100 \u00D7 200;";
    const matches = closestMatches(content, "const area = 100 x 200;");
    expect(matches.length).toBeGreaterThan(0);
    const text = formatClosestMatches(matches);
    // The per-line char diff should name the codepoint difference.
    expect(text).toContain("U+00D7");
    expect(text).toContain("line 1:");
  });
  test("enriched output includes nbsp name in whitespace diff", () => {
    // oldText has regular space; file has non-breaking space at the same spot.
    const content = "a\u00A0b";
    const matches = closestMatches(content, "a b");
    expect(matches.length).toBeGreaterThan(0);
    const text = formatClosestMatches(matches);
    expect(text).toContain("NON-BREAKING SPACE");
    expect(text).toContain("U+00A0");
  });

  test("surfaces the actual file line to copy (trailing-comma regression)", () => {
    // File has `...` (no comma); oldText has `...,`. The differing line's actual
    // text must be shown verbatim so the agent copies it instead of re-deriving
    // (re-deriving is where the stray comma gets reintroduced).
    const content = "# h\n{\n  config,\n  lib,\n  ...\n}:";
    const oldText = "# h\n{\n  config,\n  lib,\n  ...,\n}:";
    const text = formatClosestMatches(closestMatches(content, oldText));
    expect(text).toContain("file:");
    expect(text).toMatch(/file:\s+\.+\s*$/m); // the file's `...`, no trailing comma
  });

  test("char-level detail only for close matches, not low-similarity ones", () => {
    const mkMatch = (sim: number): ClosestMatch => ({
      line: 1,
      similarity: sim,
      text: "alpha\nbeta",
      diagnosis: {
        whitespaceOnly: 0,
        contentDiffer: 1,
        missingFromOldText: 0,
        extraInOldText: 0,
        lineDetails: [{ index: 0, kind: "content", chars: [{ expected: "a", actual: "b" }] }],
      },
    });
    expect(formatClosestMatches([mkMatch(0.95)])).toContain("line 1:");
    expect(formatClosestMatches([mkMatch(0.5)])).not.toContain("line 1:");
  });

  test("shows the full window for a very close match (copy-pasteable oldText)", () => {
    const content = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"].join("\n");
    const oldText = content.replace("l8", "l9");
    const text = formatClosestMatches(closestMatches(content, oldText));
    expect(text).toContain("use it as oldText");
    expect(text).toContain("l8");
    expect(text).not.toContain("more line(s)");
  });
});

// ── diagnoseLineDiff (LCS line-level diagnosis) ───────────────────────────

describe("diagnoseLineDiff", () => {
  test("identical text → all zero", () => {
    const d = diagnoseLineDiff("a\nb\nc", "a\nb\nc");
    expect(d).toEqual({
      whitespaceOnly: 0,
      contentDiffer: 0,
      missingFromOldText: 0,
      extraInOldText: 0,
      lineDetails: [],
    });
  });

  test("whitespace-only difference (tabs vs spaces)", () => {
    const d = diagnoseLineDiff("  foo\n  bar", "\tfoo\n\tbar");
    expect(d.whitespaceOnly).toBeGreaterThan(0);
    expect(d.contentDiffer).toBe(0);
  });

  test("trailing-whitespace-only difference", () => {
    const d = diagnoseLineDiff("foo   \nbar", "foo\nbar");
    expect(d.whitespaceOnly).toBeGreaterThan(0);
    expect(d.contentDiffer).toBe(0);
  });

  test("content difference", () => {
    const d = diagnoseLineDiff("foo\nbar\nbaz", "foo\nQUX\nbaz");
    expect(d.contentDiffer).toBeGreaterThan(0);
    expect(d.whitespaceOnly).toBe(0);
  });

  test("window has lines oldText lacks (oldText too short)", () => {
    const d = diagnoseLineDiff("foo\nbar", "foo\nbar\nbaz");
    expect(d.missingFromOldText).toBeGreaterThan(0);
  });

  test("oldText has lines the window lacks (oldText too long)", () => {
    const d = diagnoseLineDiff("foo\nbar\nbaz", "foo\nbar");
    expect(d.extraInOldText).toBeGreaterThan(0);
  });

  test("mixed: one whitespace line + one content line", () => {
    const d = diagnoseLineDiff("  foo\nbar", "\tfoo\nQUX");
    expect(d.whitespaceOnly).toBeGreaterThan(0);
    expect(d.contentDiffer).toBeGreaterThan(0);
  });

  test("lineDetails names the exact differing rune (× vs x)", () => {
    // oldText has ASCII 'x'; the file window has U+00D7 at the same spot.
    const d = diagnoseLineDiff("1x", "1\u00D7");
    expect(d.contentDiffer).toBe(1);
    expect(d.lineDetails).toHaveLength(1);
    const ld = d.lineDetails[0];
    expect(ld?.kind).toBe("content");
    expect(ld?.index).toBe(0);
    expect(ld?.chars).toHaveLength(1);
    expect(ld?.chars[0]?.expected).toBe("x");
    expect(ld?.chars[0]?.actual).toBe("\u00D7");
  });

  test("lineDetails flags whitespace-only line (nbsp vs space)", () => {
    const d = diagnoseLineDiff("a b", "a\u00A0b");
    expect(d.whitespaceOnly).toBe(1);
    expect(d.lineDetails[0]?.kind).toBe("whitespace");
    expect(d.lineDetails[0]?.chars[0]?.actual).toBe("\u00A0");
  });

  test("lineDetails is empty when only line counts differ", () => {
    const d = diagnoseLineDiff("foo\nbar", "foo\nbar\nbaz");
    expect(d.missingFromOldText).toBe(1);
    expect(d.lineDetails).toEqual([]);
  });
});

const EMPTY_DETAILS = { lineDetails: [] };

describe("describeDiagnosis", () => {
  test("empty → 'identical'", () => {
    expect(
      describeDiagnosis({
        whitespaceOnly: 0,
        contentDiffer: 0,
        missingFromOldText: 0,
        extraInOldText: 0,
        ...EMPTY_DETAILS,
      }),
    ).toBe("identical");
  });
  test("whitespace-only → mentions whitespace, not content", () => {
    const s = describeDiagnosis({
      whitespaceOnly: 2,
      contentDiffer: 0,
      missingFromOldText: 0,
      extraInOldText: 0,
      ...EMPTY_DETAILS,
    });
    expect(s).toContain("whitespace");
    expect(s).not.toContain("content");
  });
  test("lists each non-zero category", () => {
    const s = describeDiagnosis({
      whitespaceOnly: 1,
      contentDiffer: 2,
      missingFromOldText: 1,
      extraInOldText: 0,
      ...EMPTY_DETAILS,
    });
    expect(s).toContain("1 line");
    expect(s).toContain("whitespace");
    expect(s).toContain("2 line");
    expect(s).toContain("actual text");
    expect(s).toContain("missing 1");
    expect(s).not.toContain("extra");
  });
});

// ── diffRunes / describeCharDiff (per-codepoint naming) ──────────────────

describe("diffRunes", () => {
  test("identical → no hunks", () => {
    expect(diffRunes("abc", "abc")).toEqual([]);
  });
  test("single substitution → one hunk", () => {
    const hunks = diffRunes("1x", "1\u00D7");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.expected).toBe("x");
    expect(hunks[0]?.actual).toBe("\u00D7");
  });
  test("pure insertion → empty expected", () => {
    const hunks = diffRunes("ab", "a\u200Bb");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.expected).toBe("");
    expect(hunks[0]?.actual).toBe("\u200B");
  });
  test("pure deletion → empty actual", () => {
    const hunks = diffRunes("a\u200Bb", "ab");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.actual).toBe("");
  });
  test("splits by code point (surrogate pair stays whole)", () => {
    const poop = "\uD83D\uDCA9"; // U+1F4A9 as a surrogate pair
    const hunks = diffRunes("x", poop);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.actual).toBe(poop);
  });
  test("long lines fall back to prefix/suffix span without blowing up", () => {
    const a = "a".repeat(500);
    const b = `${"a".repeat(250)}X${"a".repeat(249)}`;
    const hunks = diffRunes(a, b);
    expect(hunks).toHaveLength(1);
    // pre=250 ('a's), suf=249 (from the right) — one 'a' at position 250 is the hunk.
    expect(hunks[0]?.expected).toBe("a");
    expect(hunks[0]?.actual).toBe("X");
  });
});

describe("describeCharDiff (invisibles named, visibles hexed, ASCII bare)", () => {
  test("non-ASCII visible: glyph + codepoint, ASCII side bare", () => {
    // The feedback's canonical example: ASCII x vs U+00D7.
    expect(describeCharDiff({ expected: "x", actual: "\u00D7" })).toBe(`'x' vs '\u00D7' (U+00D7)`);
  });
  test("em-dash: glyph + codepoint, no human name", () => {
    expect(describeCharDiff({ expected: "--", actual: "\u2014" })).toBe(`'--' vs '\u2014' (U+2014)`);
  });
  test("nbsp (invisible): named, no glyph", () => {
    expect(describeCharDiff({ expected: " ", actual: "\u00A0" })).toBe("space (U+0020) vs NON-BREAKING SPACE (U+00A0)");
  });
  test("zero-width space (invisible): named", () => {
    expect(describeCharDiff({ expected: "", actual: "\u200B" })).toBe("(nothing) vs ZERO WIDTH SPACE (U+200B)");
  });
  test("whitespace run compacts", () => {
    expect(describeCharDiff({ expected: "  ", actual: "    " })).toBe("2 spaces vs 4 spaces");
  });
  test("tabs vs spaces compacts", () => {
    expect(describeCharDiff({ expected: "\t\t", actual: "    " })).toBe("2 tabs vs 4 spaces");
  });
  test("printable ASCII only → bare literals, no codepoints", () => {
    expect(describeCharDiff({ expected: "foo", actual: "bar" })).toBe("'foo' vs 'bar'");
  });
  test("unknown non-ASCII printable still gets a codepoint (graceful)", () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL LETTER A — not in the invisibles table.
    expect(describeCharDiff({ expected: "A", actual: "\uFF21" })).toBe(`'A' vs '\uFF21' (U+FF21)`);
  });
});

// ── findNearMisses ───────────────────────────────────────────────────────

describe("findNearMisses", () => {
  test("finds normalized-equal occurrences excluded from exact hits", () => {
    // 4-space version matches exactly, 2-space version is a near-miss.
    const content = "  result = validate(data)\n    result = validate(data)\n    result = validate(data)";
    const exactLines = new Set([2, 3]); // lines 2,3 are exact (4-space)
    const miss = findNearMisses(content, "    result = validate(data)", exactLines);
    expect(miss).toHaveLength(1);
    expect(miss[0]?.line).toBe(1);
    expect(miss[0]?.text).toContain("  result = validate(data)");
  });

  test("returns empty when normalization doesn't change oldText", () => {
    const content = "foo\nfoo";
    // normalizeForFuzzyMatch("foo") === "foo", so no near-misses possible.
    expect(findNearMisses(content, "foo", new Set([1]))).toHaveLength(0);
  });

  test("excludes windows overlapping exact hits", () => {
    const content = "foo\nfoo\nfoo";
    const miss = findNearMisses(content, "foo", new Set([1, 2, 3]));
    expect(miss).toHaveLength(0);
  });

  test("finds multi-line near-misses", () => {
    const content = "  if (x) {\n    return 1;\n  }\nif (x) {\n  return 1;\n}";
    const exactLines = new Set([1, 2, 3]); // 2-space version on lines 1-3
    const miss = findNearMisses(content, "  if (x) {\n    return 1;\n  }", exactLines);
    expect(miss).toHaveLength(1);
    expect(miss[0]?.line).toBe(4);
  });
});

// ── formatOutcomes (near-miss case) ──────────────────────────────────────

describe("formatOutcomes near-miss diagnostic", () => {
  test("ambiguous outcome includes normalized-equal near-misses", () => {
    // 4-space indent matches exactly at lines 2,3; 2-space indent at line 1 is a near-miss.
    const content = "  result = validate(data)\n    result = validate(data)\n    result = validate(data)";
    const plan = planAll(content, [{ oldText: "    result = validate(data)", newText: "x" }]);
    const messages = formatOutcomes(content, plan, [{ oldText: "    result = validate(data)" }]);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("2 occurrences");
    // Near-miss should be mentioned.
    expect(messages[0]).toContain("normalized-equal");
  });
});

// ── formatHitsWithContext ──────────────────────────────────────────────────

describe("formatHitsWithContext", () => {
  test("marks the hit line with >>", () => {
    const content = "l1\nl2\nl3\nl4\nl5";
    const text = formatHitsWithContext(content, [hit(3)]);
    expect(text).toContain(">> 3: l3");
    expect(text).toContain("   1: l1"); // context lines have "  " marker
  });
});

// ── formatOutcomes ─────────────────────────────────────────────────────────

describe("formatOutcomes", () => {
  test("no-match outcome includes closest matches", () => {
    const content = "def foo():\n    return 1";
    const plan = planAll(content, [{ oldText: "def foo():\n    return 99", newText: "x" }]);
    const messages = formatOutcomes(content, plan, [{ oldText: "def foo():\n    return 99" }]);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("not found");
  });

  test("ambiguous outcome includes occurrences with context", () => {
    const content = "x = 1\nx = 1";
    const plan = planAll(content, [{ oldText: "x = 1", newText: "x = 2" }]);
    const messages = formatOutcomes(content, plan, [{ oldText: "x = 1" }]);
    expect(messages[0]).toContain("2 occurrences");
    expect(messages[0]).toContain("anchor");
  });

  test("applied outcomes produce no message", () => {
    const content = "foo\nbar";
    const plan = planAll(content, [{ oldText: "foo", newText: "FOO" }]);
    expect(formatOutcomes(content, plan, [{ oldText: "foo" }])).toHaveLength(0);
  });

  test("no-op outcome produces a self-contained message", () => {
    const content = "let scale_factor = output_sf;\n";
    const plan = planAll(content, [
      { oldText: "let scale_factor = output_sf;", newText: "let scale_factor = output_sf;" },
    ]);
    const messages = formatOutcomes(content, plan, [{ oldText: "let scale_factor = output_sf;" }]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("no-op");
    expect(messages[0]).toContain("identical");
  });
});

// ── detectBoundaryDuplication ──────────────────────────────────────────────

describe("detectBoundaryDuplication", () => {
  test("detects before-edge duplication", () => {
    const content = "line A\nline B\nline C";
    // Replacing line B (hit at line 2) but newText starts with "line A".
    const result = detectBoundaryDuplication(content, hit(2, 1), "line A\nline B CHANGED");
    expect(result?.edge).toBe("before");
    expect(result?.neighborLine).toBe(1);
  });

  test("detects after-edge duplication", () => {
    const content = "line A\nline B\nline C";
    // Replacing line B but newText ends with "line C".
    const result = detectBoundaryDuplication(content, hit(2, 1), "line B CHANGED\nline C");
    expect(result?.edge).toBe("after");
    expect(result?.neighborLine).toBe(3);
  });

  test("no duplication returns null", () => {
    const content = "line A\nline B\nline C";
    expect(detectBoundaryDuplication(content, hit(2, 1), "line B CHANGED")).toBeNull();
  });

  test("allows deletion (blank newText) even when a neighbor is blank", () => {
    // Deleting a bullet/line in a blank-separated list: newText is empty and
    // the neighbor line is also "" — must not trip the before-edge check.
    const content = "keep\n\ndelete me\n\nkeep too";
    expect(detectBoundaryDuplication(content, hit(3, 1), "")).toBeNull();
    expect(detectBoundaryDuplication(content, hit(3, 1), "   ")).toBeNull();
  });

  test("catches lone closing brace duplication (the doubled-brace case)", () => {
    const content = "  foo()\n}\n  bar()";
    // Replacing `  foo()` but newText ends with `}` — the neighbor-after line.
    // No punctuation exemption: for oldText-exact-match this is always a
    // duplicate (oldText didn't include the `}`, so it stays on disk).
    const result = detectBoundaryDuplication(content, hit(1, 1), "  REPLACED\n}");
    expect(result?.edge).toBe("after");
    expect(result?.neighborLine).toBe(2);
  });

  test("flags braces with content", () => {
    const content = "} else {\n  target line\nnext";
    // The line before the hit (line 2) is "} else {" — brace WITH content,
    // so repeating it in newText is flagged.
    const result = detectBoundaryDuplication(content, hit(2, 1), "} else {\n  REPLACED");
    expect(result?.edge).toBe("before");
  });
});

// ── countApplied ───────────────────────────────────────────────────────────

describe("countApplied", () => {
  test("counts distinct edit indices and total occurrences", () => {
    const plan = planAll("a\nb\na", [
      { oldText: "a", newText: "x", replaceAll: true },
      { oldText: "b", newText: "y" },
    ]);
    const { edits, occurrences } = countApplied(plan.replacements);
    expect(edits).toBe(2);
    expect(occurrences).toBe(3); // 2 from replaceAll + 1
  });
});

// ── detectInsertDuplication ────────────────────────────────────────────────

describe("detectInsertDuplication", () => {
  test("insertAfter: whole-block reproduction is flagged (the observed failure)", () => {
    // newText = entire anchor + new content. The old boundary check missed this
    // because newText's first line != anchor's last line. Block check catches it.
    const oldText = "header line\nbody line\nclose";
    const result = detectInsertDuplication(ins(2, "header line\nbody line\nclose\nNEW"), oldText);
    expect(result).not.toBeNull();
    expect(result).toContain("reproduces the anchor block");
  });

  test("insertAfter: partial-block reproduction (>=2 lines) is flagged", () => {
    const oldText = "first\nsecond\nthird";
    const result = detectInsertDuplication(ins(2, "first\nsecond\nNEW"), oldText);
    expect(result).not.toBeNull();
    expect(result).toContain("first 2 of 3");
  });

  test("insertAfter: boundary-line repeat is flagged (single-line case + closing brace)", () => {
    // newText's first line == anchor's last line; lead < 2 so block check misses.
    const oldText = "first\nsecond\n}";
    const result = detectInsertDuplication(ins(2, "}\nNEW"), oldText);
    expect(result).not.toBeNull();
    expect(result).toContain("anchor's last line");
  });

  test("insertAfter: clean newText returns null", () => {
    expect(detectInsertDuplication(ins(2, "brand new content"), "anchor line\nsecond")).toBeNull();
  });

  test("insertAfter: single coincidental leading line is NOT flagged (left to the diff)", () => {
    // One shared generic line (e.g. a blank or comment) shouldn't trip the guard.
    expect(detectInsertDuplication(ins(2, "// shared\nREAL new"), "// shared\nbody")).toBeNull();
  });

  test("insertBefore: whole-block reproduction (trailing) is flagged", () => {
    const oldText = "header\nbody\nclose";
    const result = detectInsertDuplication(ins(1, "NEW\nheader\nbody\nclose", "insertBefore"), oldText);
    expect(result).not.toBeNull();
    expect(result).toContain("reproduces the anchor block");
    expect(result).toContain("last 3 of 3");
  });

  test("insertBefore: partial-block reproduction (>=2 trailing lines) is flagged", () => {
    const oldText = "first\nsecond\nthird";
    const result = detectInsertDuplication(ins(1, "NEW\nsecond\nthird", "insertBefore"), oldText);
    expect(result).not.toBeNull();
    expect(result).toContain("last 2 of 3");
  });

  test("insertBefore: boundary-line repeat (anchor's first line) is flagged", () => {
    const oldText = "first\nsecond\nthird";
    const result = detectInsertDuplication(ins(1, "NEW\nfirst", "insertBefore"), oldText);
    expect(result).not.toBeNull();
    expect(result).toContain("anchor's first line");
  });

  test("insertBefore: clean newText returns null", () => {
    expect(detectInsertDuplication(ins(1, "prepended", "insertBefore"), "anchor line\nsecond")).toBeNull();
  });

  test("comparison is trim-tolerant (leading whitespace ignored)", () => {
    // Two matching leading lines (after trim) → block reproduction flagged.
    const oldText = "    alpha\n  beta";
    const result = detectInsertDuplication(ins(2, "alpha\nbeta\nNEW"), oldText);
    expect(result).not.toBeNull();
    expect(result).toContain("first 2 of 2");
  });

  test("single shared leading line is NOT flagged (the >=2 threshold avoids false positives)", () => {
    // One coincidental shared line is left to the diff, never flagged.
    expect(detectInsertDuplication(ins(2, "anchor line\nx"), "anchor line\nsecond")).toBeNull();
  });

  test("NOT robust to oldText/file normalization differences (known limitation)", () => {
    // The guard compares against the agent's oldText, not the file. If the agent
    // reproduced the anchor in newText but with normalized differences (smart vs
    // straight quotes) on line 1, the leading-prefix match breaks at that line and
    // the block check misses it. This is the residual gap; a file comparison
    // would reintroduce the robustness problem (smart != straight masks it there
    // too). Documented, not fixed — the common failure (verbatim oldText paste)
    // is caught.
    const oldText = "one \u201Cq\u201D\ntwo\nthree";
    const result = detectInsertDuplication(ins(2, "two\nthree\nNEW"), oldText);
    expect(result).toBeNull();
  });
});
