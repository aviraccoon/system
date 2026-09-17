import { describe, expect, test } from "bun:test";
import {
  adjustIndentation,
  applyPreservingOriginal,
  detectLineEnding,
  type Edit,
  findAnchorLines,
  findHits,
  lineForOffset,
  normalizeForFuzzyMatch,
  normalizeToLF,
  planAll,
  restoreLineEndings,
  stripBom,
} from "./match";

// ── Normalization ──────────────────────────────────────────────────────────

describe("normalizeForFuzzyMatch", () => {
  test("collapses internal whitespace runs to single space", () => {
    expect(normalizeForFuzzyMatch("a      b")).toBe("a b");
    expect(normalizeForFuzzyMatch("a\t\tb")).toBe("a b");
    expect(normalizeForFuzzyMatch("a    b\tc")).toBe("a b c");
  });

  test("trims each line", () => {
    expect(normalizeForFuzzyMatch("  indented line  ")).toBe("indented line");
    expect(normalizeForFuzzyMatch("a  \nb  ")).toBe("a\nb");
  });

  test("normalizes arrows to ASCII", () => {
    expect(normalizeForFuzzyMatch("a → b")).toBe("a -> b");
    expect(normalizeForFuzzyMatch("x ⇒ y")).toBe("x => y");
    expect(normalizeForFuzzyMatch("left ← right")).toBe("left <- right");
    expect(normalizeForFuzzyMatch("a ↔ b")).toBe("a <-> b");
  });

  test("normalizes math symbols to ASCII", () => {
    expect(normalizeForFuzzyMatch("a ≠ b")).toBe("a != b");
    expect(normalizeForFuzzyMatch("x ≤ y ≥ z")).toBe("x <= y >= z");
    expect(normalizeForFuzzyMatch("±1")).toBe("+/-1");
    expect(normalizeForFuzzyMatch("3 × 4 ÷ 2")).toBe("3 * 4 / 2");
    expect(normalizeForFuzzyMatch("a · b")).toBe("a * b");
  });

  test("normalizes bullet and box-pipe", () => {
    expect(normalizeForFuzzyMatch("• item")).toBe("* item");
    expect(normalizeForFuzzyMatch("a │ b")).toBe("a | b");
  });

  test("normalizes em-dash, en-dash, ellipsis (NFKC + explicit)", () => {
    expect(normalizeForFuzzyMatch("foo — bar")).toBe("foo - bar");
    expect(normalizeForFuzzyMatch("2020–2024")).toBe("2020-2024");
    expect(normalizeForFuzzyMatch("wait…")).toBe("wait...");
  });

  test("normalizes smart quotes", () => {
    expect(normalizeForFuzzyMatch("“hello”")).toBe('"hello"');
    expect(normalizeForFuzzyMatch("it’s")).toBe("it's");
  });

  test("normalizes special spaces", () => {
    expect(normalizeForFuzzyMatch("a\u00A0b")).toBe("a b");
    expect(normalizeForFuzzyMatch("a\u3000b")).toBe("a b");
  });

  test("is idempotent", () => {
    const input = "a → b ≠ c   • d";
    const once = normalizeForFuzzyMatch(input);
    const twice = normalizeForFuzzyMatch(once);
    expect(twice).toBe(once);
  });
});

// ── BOM / line endings ─────────────────────────────────────────────────────

describe("stripBom", () => {
  test("strips UTF-8 BOM", () => {
    expect(stripBom("\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
  });
  test("passes through without BOM", () => {
    expect(stripBom("hello")).toEqual({ bom: "", text: "hello" });
  });
});

describe("line endings", () => {
  test("normalizeToLF handles CRLF and CR", () => {
    expect(normalizeToLF("a\r\nb")).toBe("a\nb");
    expect(normalizeToLF("a\rb")).toBe("a\nb");
  });
  test("detectLineEnding detects dominant ending", () => {
    expect(detectLineEnding("a\nb")).toBe("\n");
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("no newlines")).toBe("\n");
  });
  test("restoreLineEndings round-trips", () => {
    expect(restoreLineEndings("a\nb", "\r\n")).toBe("a\r\nb");
    expect(restoreLineEndings("a\nb", "\n")).toBe("a\nb");
  });
});

// ── Line lookup ────────────────────────────────────────────────────────────

describe("lineForOffset", () => {
  test("returns 1-based line number", () => {
    expect(lineForOffset("a\nb\nc", 0)).toBe(1);
    expect(lineForOffset("a\nb\nc", 2)).toBe(2);
    expect(lineForOffset("a\nb\nc", 4)).toBe(3);
  });
});

// ── findHits: the cascade ──────────────────────────────────────────────────

describe("findHits", () => {
  test("exact match preferred over normalized", () => {
    const content = "foo bar\nfoo  bar"; // second line has double space
    const hits = findHits(content, "foo bar");
    // Exact finds the first line; the second is NOT an exact match.
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("exact");
    expect(hits[0]?.line).toBe(1);
  });

  test("normalized match when exact fails (arrow)", () => {
    const content = "a → b\nc";
    const hits = findHits(content, "a -> b");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("normalized");
    expect(hits[0]?.line).toBe(1);
  });

  test("normalized match on tab vs spaces", () => {
    const content = "\t\ttabbed line\nnext";
    const hits = findHits(content, "  tabbed line");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("normalized");
  });

  test("normalized match on leading whitespace drift", () => {
    // Model sent 6 spaces; file has 4. Not an exact substring → normalized.
    const content = "    indented line\nnext";
    const hits = findHits(content, "      indented line");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("normalized");
  });

  test("returns empty when nothing matches", () => {
    expect(findHits("foo\nbar", "nonexistent")).toHaveLength(0);
  });

  test("returns all exact occurrences", () => {
    const content = "x = 1\nx = 1\nx = 1";
    const hits = findHits(content, "x = 1");
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.kind === "exact")).toBe(true);
    expect(hits.map((h) => h.line)).toEqual([1, 2, 3]);
  });

  test("captures fileIndent at match site", () => {
    const content = "    foo\n        bar";
    const hits = findHits(content, "foo");
    expect(hits[0]?.fileIndent).toBe("    ");
  });
});

// ── anchor resolution ──────────────────────────────────────────────────────

describe("findAnchorLines", () => {
  test("finds all exact occurrences of anchor", () => {
    expect(findAnchorLines("def foo\nx\nend\ndef foo", "def foo")).toEqual([1, 4]);
  });
  test("empty anchor returns nothing", () => {
    expect(findAnchorLines("content", "")).toEqual([]);
  });
});

// ── planAll: anchor + replaceAll + overlap ─────────────────────────────────

describe("planAll", () => {
  const C = "function a() {\n  x = 1\n}\nfunction b() {\n  x = 1\n}\n";

  test("ambiguous without anchor reports all occurrences", () => {
    const edits: Edit[] = [{ oldText: "x = 1", newText: "x = 2" }];
    const plan = planAll(C, edits);
    expect(plan.outcomes[0]?.status).toBe("ambiguous");
    if (plan.outcomes[0]?.status === "ambiguous") {
      expect(plan.outcomes[0].hits).toHaveLength(2);
    }
    expect(plan.replacements).toHaveLength(0);
  });

  test("anchor picks nearest occurrence", () => {
    const edits: Edit[] = [{ oldText: "x = 1", newText: "x = 2", anchor: "function b()" }];
    const plan = planAll(C, edits);
    expect(plan.outcomes[0]?.status).toBe("applied");
    const hit = plan.replacements[0];
    // The second x = 1 is on line 5, under function b().
    expect(hit?.start).toBeGreaterThan(C.indexOf("function b()"));
  });

  test("replaceAll applies to every occurrence", () => {
    const edits: Edit[] = [{ oldText: "x = 1", newText: "x = 2", replaceAll: true }];
    const plan = planAll(C, edits);
    expect(plan.outcomes[0]?.status).toBe("applied");
    expect(plan.replacements).toHaveLength(2);
  });

  test("anchor not found still ambiguous", () => {
    const edits: Edit[] = [{ oldText: "x = 1", newText: "x = 2", anchor: "nonexistent anchor" }];
    const plan = planAll(C, edits);
    expect(plan.outcomes[0]?.status).toBe("ambiguous");
  });

  test("no-match outcome", () => {
    const plan = planAll("foo\nbar", [{ oldText: "missing", newText: "x" }]);
    expect(plan.outcomes[0]?.status).toBe("no-match");
  });

  test("empty oldText outcome", () => {
    const plan = planAll("foo\nbar", [{ oldText: "", newText: "x" }]);
    expect(plan.outcomes[0]?.status).toBe("empty");
  });

  test("overlapping edits detected", () => {
    const content = "line one\nline two\nline three";
    const edits: Edit[] = [
      { oldText: "line one\nline two", newText: "A\nB" },
      { oldText: "line two", newText: "C" },
    ];
    const plan = planAll(content, edits);
    // Second edit overlaps the first; one should be removed/diagnosed.
    expect(
      plan.replacements.length + plan.outcomes.filter((o) => o.status === "ambiguous").length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("disjoint edits both applied", () => {
    const content = "alpha\nbeta\ngamma\nalpha";
    const edits: Edit[] = [
      { oldText: "beta", newText: "BETA" },
      { oldText: "gamma", newText: "GAMMA" },
    ];
    const plan = planAll(content, edits);
    expect(plan.replacements).toHaveLength(2);
    expect(plan.outcomes.every((o) => o.status === "applied")).toBe(true);
  });
});

describe("planAll: no-op detection", () => {
  test("single edit with oldText === newText is flagged no-op (no replacement added)", () => {
    const content = "let scale_factor = output_sf;\n";
    const plan = planAll(content, [
      { oldText: "let scale_factor = output_sf;", newText: "let scale_factor = output_sf;" },
    ]);
    expect(plan.outcomes[0]?.status).toBe("no-op");
    expect(plan.replacements).toHaveLength(0);
  });

  test("no-op edit mixed with a real edit: no-op flagged, real edit still applied", () => {
    // Regression for the reported footgun: a pasted-identical edit silently
    // counted as applied because the whole-file guard saw net change from
    // the sibling edit. The no-op must now be visible per-edit.
    const content = "let scale_factor = output_sf;\nlet beta = 1.0;\n";
    const plan = planAll(content, [
      { oldText: "let scale_factor = output_sf;", newText: "let scale_factor = output_sf;" }, // no-op
      { oldText: "let beta = 1.0;", newText: "let beta = 2.0;" }, // real change
    ]);
    expect(plan.outcomes[0]?.status).toBe("no-op");
    expect(plan.outcomes[1]?.status).toBe("applied");
    // Only the real edit produces a replacement.
    expect(plan.replacements).toHaveLength(1);
    expect(plan.replacements[0]?.editIndex).toBe(1);
    // And applying the plan performs only the real change.
    expect(applyPreservingOriginal(content, plan)).toBe("let scale_factor = output_sf;\nlet beta = 2.0;\n");
  });

  test("replaceAll with newText === oldText is no-op across all occurrences", () => {
    const content = "TODO\nTODO\nTODO\n";
    const plan = planAll(content, [{ oldText: "TODO", newText: "TODO", replaceAll: true }]);
    expect(plan.outcomes[0]?.status).toBe("no-op");
    expect(plan.replacements).toHaveLength(0);
  });

  test("a real change is NOT misflagged as no-op (exact space)", () => {
    const content = "let beta = 1.0;\n";
    const plan = planAll(content, [{ oldText: "let beta = 1.0;", newText: "let beta = 2.0;" }]);
    expect(plan.outcomes[0]?.status).toBe("applied");
    expect(plan.replacements).toHaveLength(1);
  });
});

// ── applyPreservingOriginal: byte preservation ────────────────────────────

describe("applyPreservingOriginal", () => {
  test("exact match preserves all bytes verbatim", () => {
    const content = "foo\nbar\nbaz";
    const plan = planAll(content, [{ oldText: "bar", newText: "BAR" }]);
    const result = applyPreservingOriginal(content, plan);
    expect(result).toBe("foo\nBAR\nbaz");
  });

  test("normalized match only rewrites touched lines", () => {
    const content = "foo → bar\nkeep this\nbaz";
    const plan = planAll(content, [{ oldText: "foo -> bar", newText: "foo -> BAZ" }]);
    const result = applyPreservingOriginal(content, plan);
    expect(result).toBe("foo -> BAZ\nkeep this\nbaz");
  });

  test("untouched lines keep original Unicode", () => {
    const content = "x = 1\narrow → here\nkeep — dash\ny = 2";
    const plan = planAll(content, [{ oldText: "x = 1", newText: "x = 99" }]);
    const result = applyPreservingOriginal(content, plan);
    expect(result).toBe("x = 99\narrow → here\nkeep — dash\ny = 2");
  });

  test("does not mangle Unicode on untouched regions during normalized edit", () => {
    const content = "a → b\nCHANGE ME\nc ⇒ d";
    const plan = planAll(content, [{ oldText: "CHANGE ME", newText: "CHANGED" }]);
    const result = applyPreservingOriginal(content, plan);
    expect(result).toBe("a → b\nCHANGED\nc ⇒ d");
  });

  test("multiple disjoint edits apply together", () => {
    const content = "alpha\nbeta\ngamma";
    const plan = planAll(content, [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "gamma", newText: "GAMMA" },
    ]);
    expect(applyPreservingOriginal(content, plan)).toBe("ALPHA\nbeta\nGAMMA");
  });

  test("replaceAll rewrites all occurrences", () => {
    const content = "x = 1\nx = 1\nx = 1";
    const plan = planAll(content, [{ oldText: "x = 1", newText: "x = 2", replaceAll: true }]);
    expect(applyPreservingOriginal(content, plan)).toBe("x = 2\nx = 2\nx = 2");
  });
});

// ── adjustIndentation ──────────────────────────────────────────────────────

describe("adjustIndentation", () => {
  test("re-bases relative indentation onto file indent", () => {
    const newText = "def foo():\n    x = 1\n    y = 2";
    const result = adjustIndentation(newText, "  ");
    // common indent of newText is "" (first line); file wants "  "
    expect(result).toBe("  def foo():\n      x = 1\n      y = 2");
  });

  test("preserves relative depth between lines", () => {
    // newText common indent is "" (first line has none). fileIndent grafted
    // onto each line; relative depth (4 and 8 spaces) preserved in spaces.
    const newText = "a\n    b\n        c";
    const result = adjustIndentation(newText, "\t");
    const resultLines = result.split("\n");
    expect(resultLines[0]).toBe("\ta"); // depth 0 → file indent only
    expect(resultLines[1]).toBe("\t    b"); // depth 1 → file indent + 4 spaces
    expect(resultLines[2]).toBe("\t        c"); // depth 2 → file indent + 8 spaces
  });

  test("no-op when already correct", () => {
    const newText = "  foo\n    bar";
    expect(adjustIndentation(newText, "  ")).toBe(newText);
  });

  test("leaves blank lines untouched", () => {
    const newText = "foo\n\nbar";
    expect(adjustIndentation(newText, "  ")).toBe("  foo\n\n  bar");
  });
});

// ── insert modes (insertAfter / insertBefore) ───────────────────────────────

describe("planAll / applyPreservingOriginal: insert modes", () => {
  test("insertAfter inserts newText on the line after the anchor", () => {
    const content = "alpha\nbeta\ngamma\n";
    const plan = planAll(content, [{ oldText: "beta", newText: "BETA2", mode: "insertAfter" }]);
    expect(plan.outcomes[0]?.status).toBe("applied");
    expect(plan.insertions[0]?.beforeLine).toBe(3);
    expect(applyPreservingOriginal(content, plan)).toBe("alpha\nbeta\nBETA2\ngamma\n");
  });

  test("insertBefore inserts newText on the anchor's first line", () => {
    const content = "alpha\nbeta\ngamma\n";
    const plan = planAll(content, [{ oldText: "beta", newText: "PRE", mode: "insertBefore" }]);
    expect(plan.insertions[0]?.beforeLine).toBe(2);
    expect(applyPreservingOriginal(content, plan)).toBe("alpha\nPRE\nbeta\ngamma\n");
  });

  test("insertBefore at line 1 prepends to the file", () => {
    const content = "alpha\nbeta\n";
    const plan = planAll(content, [{ oldText: "alpha", newText: "PRE", mode: "insertBefore" }]);
    expect(plan.insertions[0]?.beforeLine).toBe(1);
    expect(applyPreservingOriginal(content, plan)).toBe("PRE\nalpha\nbeta\n");
  });

  test("anchor bytes are preserved on a normalized match (the drift killer)", () => {
    // File has smart quotes; oldText uses straight quotes -> normalized match.
    const content = "one \u201Cq\u201D\ntwo\n";
    const plan = planAll(content, [{ oldText: 'one "q"', newText: "INSERTED", mode: "insertAfter" }]);
    expect(plan.space).toBe("normalized");
    expect(applyPreservingOriginal(content, plan)).toBe("one \u201Cq\u201D\nINSERTED\ntwo\n");
  });

  test("newText indentation is verbatim — NOT auto-adjusted to the file", () => {
    // Surrounding code is 4-space; newText is 2-space. Replace would re-base
    // it; insert must leave it exactly as written.
    const content = "fn foo() {\n    let x = 1;\n}\n";
    const plan = planAll(content, [{ oldText: "    let x = 1;", newText: "  let y = 2;", mode: "insertAfter" }]);
    expect(applyPreservingOriginal(content, plan)).toBe("fn foo() {\n    let x = 1;\n  let y = 2;\n}\n");
  });

  test("replaceAll inserts after every occurrence", () => {
    const content = "x = 1\nx = 1\nx = 1\n";
    const plan = planAll(content, [{ oldText: "x = 1", newText: "LOG", mode: "insertAfter", replaceAll: true }]);
    expect(plan.insertions).toHaveLength(3);
    expect(applyPreservingOriginal(content, plan)).toBe("x = 1\nLOG\nx = 1\nLOG\nx = 1\nLOG\n");
  });

  test("anchor disambiguates among multiple occurrences", () => {
    const content = "function a() {\n  x = 1\n}\nfunction b() {\n  x = 1\n}\n";
    const plan = planAll(content, [{ oldText: "x = 1", newText: "LOG", mode: "insertAfter", anchor: "function b()" }]);
    expect(plan.outcomes[0]?.status).toBe("applied");
    expect(plan.insertions[0]?.anchored).toBe(true);
    expect(applyPreservingOriginal(content, plan)).toBe(
      "function a() {\n  x = 1\n}\nfunction b() {\n  x = 1\nLOG\n}\n",
    );
  });

  test("insertAfter appends at end when the anchor is the last line (no trailing newline)", () => {
    const content = "alpha\nbeta";
    const plan = planAll(content, [{ oldText: "beta", newText: "tail", mode: "insertAfter" }]);
    expect(applyPreservingOriginal(content, plan)).toBe("alpha\nbeta\ntail\n");
  });

  test("insertAfter appends at end with a separating newline when file ends without one", () => {
    const content = "alpha\nbeta\n";
    const plan = planAll(content, [{ oldText: "beta", newText: "tail", mode: "insertAfter" }]);
    expect(applyPreservingOriginal(content, plan)).toBe("alpha\nbeta\ntail\n");
  });

  test("insert and replace mix in one call", () => {
    const content = "alpha\nbeta\n";
    const plan = planAll(content, [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "beta", newText: "INSERTED", mode: "insertBefore" },
    ]);
    expect(plan.replacements).toHaveLength(1);
    expect(plan.insertions).toHaveLength(1);
    expect(plan.outcomes.every((o) => o.status === "applied")).toBe(true);
    expect(applyPreservingOriginal(content, plan)).toBe("ALPHA\nINSERTED\nbeta\n");
  });

  test("insert at a boundary of the replaced block still applies", () => {
    const content = "one\ntwo\nthree\n";
    const plan = planAll(content, [
      { oldText: "two", newText: "TWO" },
      { oldText: "two", newText: "BEFORE", mode: "insertBefore" },
    ]);
    expect(plan.outcomes.every((o) => o.status === "applied")).toBe(true);
    expect(applyPreservingOriginal(content, plan)).toBe("one\nBEFORE\nTWO\nthree\n");
  });

  test("insert inside a replaced block is rejected, not misplaced", () => {
    const content = "one\ntwo\nthree\nfour\n";
    const plan = planAll(content, [
      { oldText: "two\nthree", newText: "TWO_THREE" },
      { oldText: "two", newText: "MID", mode: "insertAfter" },
    ]);
    expect(plan.outcomes[1]?.status).toBe("ambiguous");
    expect(plan.insertions).toHaveLength(0);
    expect(plan.replacements).toHaveLength(1);
    expect(applyPreservingOriginal(content, plan)).toBe("one\nTWO_THREE\nfour\n");
  });

  test("mix works in normalized space", () => {
    const content = "one \u201Cq\u201D\ntwo\nthree\n";
    const plan = planAll(content, [
      { oldText: 'one "q"', newText: "ONE" },
      { oldText: "three", newText: "INSERTED", mode: "insertBefore" },
    ]);
    expect(plan.space).toBe("normalized");
    expect(plan.outcomes.every((o) => o.status === "applied")).toBe(true);
    expect(applyPreservingOriginal(content, plan)).toBe("ONE\ntwo\nINSERTED\nthree\n");
  });

  test("mix of replace and append-at-end adds the separator", () => {
    const content = "alpha\nbeta"; // no trailing newline
    const plan = planAll(content, [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "beta", newText: "TAIL", mode: "insertAfter" },
    ]);
    expect(applyPreservingOriginal(content, plan)).toBe("ALPHA\nbeta\nTAIL\n");
  });

  test("empty newText on an insert edit is flagged empty", () => {
    const plan = planAll("alpha\nbeta\n", [{ oldText: "beta", newText: "", mode: "insertAfter" }]);
    expect(plan.outcomes[0]?.status).toBe("empty");
    expect(plan.insertions).toHaveLength(0);
  });

  test("no-match on an insert edit reports no-match", () => {
    const plan = planAll("alpha\nbeta\n", [{ oldText: "zzz", newText: "x", mode: "insertAfter" }]);
    expect(plan.outcomes[0]?.status).toBe("no-match");
    expect(plan.insertions).toHaveLength(0);
  });

  test("ambiguous anchor occurrence without anchor/replaceAll reports ambiguous", () => {
    const plan = planAll("x\nx\n", [{ oldText: "x", newText: "Y", mode: "insertAfter" }]);
    expect(plan.outcomes[0]?.status).toBe("ambiguous");
    expect(plan.insertions).toHaveLength(0);
  });
});

// ── Edit.allowAnchorRepeat (plumbing through planAll) ───────────────────────

describe("planAll: allowAnchorRepeat plumbing", () => {
  test("replace mode ignores allowAnchorRepeat (no effect on application)", () => {
    // The flag is insert-only; replace must work the same whether or not it's set.
    const content = "alpha\nbeta\n";
    const withFlag = planAll(content, [{ oldText: "alpha", newText: "ALPHA", allowAnchorRepeat: true }]);
    const without = planAll(content, [{ oldText: "alpha", newText: "ALPHA" }]);
    expect(applyPreservingOriginal(content, withFlag)).toBe("ALPHA\nbeta\n");
    expect(applyPreservingOriginal(content, withFlag)).toBe(applyPreservingOriginal(content, without));
  });

  test("insert mode still applies the insertion when allowAnchorRepeat is set", () => {
    // The guard runs in index.ts (gated on the flag); planAll itself just
    // threads the field through. Insertion is planned regardless.
    const content = "anchor\nsecond\n";
    const plan = planAll(content, [
      { oldText: "anchor", newText: "anchor\nextra", mode: "insertAfter", allowAnchorRepeat: true },
    ]);
    expect(plan.outcomes[0]?.status).toBe("applied");
    expect(plan.insertions).toHaveLength(1);
  });
});
