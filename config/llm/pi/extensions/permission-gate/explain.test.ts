import { describe, expect, test } from "bun:test";
import { verdictFromFactors } from "../shared/risk-factors";
import {
  applyEditFloor,
  blockReason,
  classificationEntry,
  describeToolCall,
  factorsToExplanation,
  findVerdictLine,
  mergeExplanations,
  noteMessage,
  notesMessage,
  parseExplanation,
} from "./explain";

// ── factorsToExplanation ──

describe("factorsToExplanation", () => {
  test("puts the fired factors and their scores on the short line", () => {
    const decision = verdictFromFactors({ mutates_state: 0.9, touches_credentials: 0.6, runs_remote_code: 0.1 });
    const explanation = factorsToExplanation(decision);
    expect(explanation.verdict).toBe("risky");
    expect(explanation.short).toBe("jev: mutates_state 0.90, touches_credentials 0.60");
    expect(explanation.detail).toContain("thresholds: risky >= 0.50, dangerous >= 0.70");
    expect(explanation.detail).toContain("* mutates_state 0.90");
    expect(explanation.detail).not.toContain("runs_remote_code 0.10");
  });

  test("says so when nothing fired", () => {
    const explanation = factorsToExplanation(verdictFromFactors({ mutates_state: 0.2 }));
    expect(explanation.verdict).toBe("safe");
    expect(explanation.short).toBe("jev: nothing fired");
    expect(explanation.detail).toContain("thresholds:");
  });

  test("carries the backend label", () => {
    expect(factorsToExplanation(verdictFromFactors({}), "chat").short).toBe("chat: nothing fired");
  });
});

describe("mergeExplanations", () => {
  test("keeps the decisions verdict and puts the human sentence first", () => {
    const merged = mergeExplanations(
      { verdict: "risky", short: "jev: mutates_state 0.95", detail: "thresholds: risky >= 0.50" },
      { verdict: "safe", short: "Deletes a build directory", detail: "The command removes the output folder." },
    );
    expect(merged.verdict).toBe("risky");
    expect(merged.short).toBe("Deletes a build directory \u00b7 jev: mutates_state 0.95");
    expect(merged.detail).toContain("thresholds: risky >= 0.50");
    expect(merged.detail).toContain("The command removes the output folder.");
  });
});

describe("classificationEntry", () => {
  test("carries the verdict, the scores line and the detail", () => {
    const entry = classificationEntry("bash", "call_1", {
      verdict: "risky",
      short: "jev: mutates_state 0.95",
      detail: "thresholds: risky >= 0.50",
    });
    expect(entry).toEqual({
      event: "classified",
      toolCallId: "call_1",
      toolName: "bash",
      verdict: "risky",
      short: "jev: mutates_state 0.95",
      detail: "thresholds: risky >= 0.50",
    });
  });
});

describe("applyEditFloor", () => {
  const safe = { verdict: "safe" as const, short: "jev: nothing fired", detail: "thresholds: risky >= 0.50" };

  test("lifts a safe verdict on a write to risky", () => {
    const floored = applyEditFloor(safe, true);
    expect(floored.verdict).toBe("risky");
    expect(floored.short).toContain("(edits files)");
    expect(floored.detail).toContain("mutation assumed");
  });

  test("leaves reads and higher verdicts untouched", () => {
    expect(applyEditFloor(safe, false)).toEqual(safe);
    const dangerous = { verdict: "dangerous" as const, short: "", detail: "" };
    expect(applyEditFloor(dangerous, true)).toEqual(dangerous);
  });
});

// ── describeToolCall ──

describe("describeToolCall", () => {
  test("bash command", () => {
    expect(describeToolCall("bash", { command: "ls -la" })).toBe("bash command: ls -la");
  });

  test("write with short content", () => {
    const result = describeToolCall("write", { path: "/tmp/test.txt", content: "hello" });
    expect(result).toBe("write to /tmp/test.txt:\nhello");
  });

  test("write passes full content", () => {
    const long = "x".repeat(600);
    const result = describeToolCall("write", { path: "/tmp/test.txt", content: long });
    expect(result).toContain(long);
  });

  test("edit with oldText/newText", () => {
    const result = describeToolCall("edit", { path: "file.ts", oldText: "old", newText: "new" });
    expect(result).toBe('edit file.ts: "old" -> "new"');
  });

  test("edit with edits array", () => {
    const result = describeToolCall("edit", {
      path: "file.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d" },
      ],
    });
    expect(result).toContain("edit file.ts (2 edits)");
    expect(result).toContain('edit 1: "a" -> "b"');
    expect(result).toContain('edit 2: "c" -> "d"');
  });

  test("edit with undefined newText (edits array form missing)", () => {
    const result = describeToolCall("edit", { path: "file.ts" });
    expect(result).toBe('edit file.ts: "" -> ""');
  });

  test("patch uses toolName in summary and includes per-edit path", () => {
    const result = describeToolCall("patch", {
      path: "file.ts",
      edits: [
        { oldText: "a", newText: "b" },
        { oldText: "c", newText: "d", path: "other.ts" },
      ],
    });
    expect(result).toContain("patch file.ts (2 edits)");
    expect(result).toContain('patch 1: "a" -> "b"');
    expect(result).toContain('patch 2: "c" -> "d" @ other.ts');
  });

  test("unknown tool uses JSON", () => {
    const result = describeToolCall("custom", { foo: "bar" });
    expect(result).toContain("custom:");
    expect(result).toContain('"foo":"bar"');
  });

  test("unknown tool truncates long JSON", () => {
    const result = describeToolCall("custom", { data: "x".repeat(1000) });
    expect(result.length).toBeLessThanOrEqual(510); // "custom: " + 500
  });
});

// ── parseExplanation ──

describe("parseExplanation", () => {
  test("pipe delimiter", () => {
    const result = parseExplanation("SAFE|Reads a config file");
    expect(result.verdict).toBe("safe");
    expect(result.short).toBe("Reads a config file");
    expect(result.detail).toBe("");
  });

  test("colon delimiter", () => {
    const result = parseExplanation("DANGEROUS: Deletes everything");
    expect(result.verdict).toBe("dangerous");
    expect(result.short).toBe("Deletes everything");
  });

  test("dash delimiter", () => {
    const result = parseExplanation("RISKY - Modifies system config");
    expect(result.verdict).toBe("risky");
    expect(result.short).toBe("Modifies system config");
  });

  test("with detail on subsequent lines", () => {
    const result = parseExplanation("SAFE|Reads package.json\n\nThis is a standard read operation.");
    expect(result.verdict).toBe("safe");
    expect(result.short).toBe("Reads package.json");
    expect(result.detail).toBe("This is a standard read operation.");
  });

  test("multiline detail", () => {
    const result = parseExplanation("DANGEROUS|Deletes home dir\n\nFirst line of detail.\nSecond line.");
    expect(result.verdict).toBe("dangerous");
    expect(result.short).toBe("Deletes home dir");
    expect(result.detail).toBe("First line of detail.\nSecond line.");
  });

  test("no verdict prefix defaults to risky", () => {
    const result = parseExplanation("Just some text without a verdict");
    expect(result.verdict).toBe("risky");
    expect(result.short).toBe("Just some text without a verdict");
  });

  test("case insensitive verdict", () => {
    const result = parseExplanation("dangerous|bad stuff");
    expect(result.verdict).toBe("dangerous");
    expect(result.short).toBe("bad stuff");
  });

  test("handles whitespace", () => {
    const result = parseExplanation("  SAFE |  Reads a file  \n\n  Some detail  ");
    expect(result.verdict).toBe("safe");
    expect(result.short).toBe("Reads a file");
    expect(result.detail).toBe("Some detail");
  });

  test("empty string", () => {
    const result = parseExplanation("");
    expect(result.verdict).toBe("risky");
    expect(result.short).toBe("");
    expect(result.detail).toBe("");
  });

  test("verdict only, no description after delimiter", () => {
    const result = parseExplanation("SAFE|");
    expect(result?.verdict).toBe("safe");
    // short falls back to the full first line since stripped is empty
    expect(result?.short).toBe("SAFE|");
  });

  // Strict mode (for auto-classify)
  test("strict: returns null when no verdict found", () => {
    const result = parseExplanation("Just some rambling text", true);
    expect(result).toBeNull();
  });

  test("strict: returns result when verdict is present", () => {
    const result = parseExplanation("SAFE|Reads a file", true);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("safe");
    expect(result?.short).toBe("Reads a file");
  });

  test("strict: returns null on empty string", () => {
    const result = parseExplanation("", true);
    expect(result).toBeNull();
  });

  test("strict: returns result for DANGEROUS", () => {
    const result = parseExplanation("DANGEROUS|Deletes everything", true);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("dangerous");
  });

  test("non-strict: defaults to risky when no verdict", () => {
    const result = parseExplanation("Random text without verdict");
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("risky");
  });
});

// ── findVerdictLine ──

describe("findVerdictLine", () => {
  test("verdict on first line", () => {
    const result = findVerdictLine("SAFE|Reads a file");
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("safe");
    expect(result?.lineIdx).toBe(0);
  });

  test("trailing verdict wins over first line", () => {
    const text = "SAFE: This seems fine\nActually on second thought\nRISKY|This is risky";
    const result = findVerdictLine(text);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("risky");
    expect(result?.lineIdx).toBe(2);
  });

  test("first line verdict when no trailing verdict", () => {
    const text = "DANGEROUS|Mass destruction\nSome reasoning here";
    const result = findVerdictLine(text);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("dangerous");
    expect(result?.lineIdx).toBe(0);
  });

  test("returns null when no verdict anywhere", () => {
    const result = findVerdictLine("Just some text\nNo verdict here");
    expect(result).toBeNull();
  });
});

// ── noteMessage ──

describe("noteMessage", () => {
  test("keeps the note verbatim and appends the call it refers to", () => {
    expect(noteMessage("don't do that", "bash", { command: "rm -rf build" })).toBe(
      "don't do that\n\n[note on the bash call: rm -rf build]",
    );
  });

  test("uses the path for file tools, including patch's per-edit paths", () => {
    expect(noteMessage("use staging", "write", { path: "/srv/app/config.yml" })).toBe(
      "use staging\n\n[note on the write call: /srv/app/config.yml]",
    );
    expect(noteMessage("no", "patch", { edits: [{ path: "src/a.ts" }] })).toContain("src/a.ts");
  });

  test("collapses whitespace and clips long input", () => {
    expect(noteMessage("no", "bash", { command: "echo a\necho b" })).toBe(
      "no\n\n[note on the bash call: echo a echo b]",
    );
    const long = noteMessage("careful", "bash", { command: "x".repeat(300) });
    expect(long).toContain(`${"x".repeat(99)}...`);
    expect(long.length).toBeLessThan(200);
  });

  test("falls back to the tool description for unknown tools", () => {
    expect(noteMessage("hmm", "weird_tool", { query: "abc" })).toContain("[note on the weird_tool call: ");
  });
});

// ── notesMessage ──

describe("notesMessage", () => {
  test("joins blocks in order with a blank line", () => {
    expect(notesMessage(["a\n\n[bash: one]", "b\n\n[bash: two]"])).toBe("a\n\n[bash: one]\n\nb\n\n[bash: two]");
  });

  test("a single note is unchanged", () => {
    expect(notesMessage(["only"])).toBe("only");
  });
});

// ── blockReason ──

describe("blockReason", () => {
  test("bash: blocked status only, no user note", () => {
    expect(blockReason(null, "bash")).toBe(
      "BLOCKED by user. The command was NOT executed. Do not retry unless the user asks.",
    );
  });

  test("explanation for edit", () => {
    const expl = { verdict: "dangerous" as const, short: "Deletes everything", detail: "" };
    expect(blockReason(expl, "edit")).toBe(
      "BLOCKED by user. The file was NOT modified. Do not retry unless the user asks.\n[Automated command classification: DANGEROUS \u2014 Deletes everything]",
    );
  });

  test("tirith note follows the classification", () => {
    const expl = { verdict: "risky" as const, short: "Modifies config", detail: "" };
    expect(blockReason(expl, "write", "tirith: HIGH")).toBe(
      "BLOCKED by user. The file was NOT written. Do not retry unless the user asks.\n[Automated command classification: RISKY \u2014 Modifies config]\ntirith: HIGH",
    );
  });

  test("unknown tool uses generic verb", () => {
    expect(blockReason(null, "unknown_tool")).toBe(
      "BLOCKED by user. The action was NOT performed. Do not retry unless the user asks.",
    );
  });

  test("no tool name uses generic verb", () => {
    expect(blockReason(null)).toBe("BLOCKED by user. The action was NOT performed. Do not retry unless the user asks.");
  });
});
