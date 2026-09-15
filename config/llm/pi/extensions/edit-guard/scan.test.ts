import { describe, expect, test } from "bun:test";
import {
  type CompiledPathRule,
  compileRules,
  DEFAULT_RULE_CONFIG,
  mergeRuleConfigs,
  type RuleConfig,
  type RuntimeRoots,
  validateRuleConfig,
} from "./rules";
import { formatViolations, scanContent, type Violation } from "./scan";

const { rules: compiled, errors } = compileRules(DEFAULT_RULE_CONFIG);

function pick(displayName: string): CompiledPathRule {
  const rule = compiled.find((r) => r.displayName === displayName);
  if (!rule) throw new Error(`missing expected default rule "${displayName}"`);
  return rule;
}

const todoRule = pick("TODO.md");
const journalRule = pick("public file");
const codenameRule = pick("internal codename");

if (errors.length > 0) throw new Error(`default rules failed to compile: ${errors.join("; ")}`);

const roots: RuntimeRoots = {
  cwd: "/tmp/eg/repo",
  notesDir: "/tmp/eg/notes",
  sessionsDir: "/tmp/eg/sessions",
};

function labelsOf(violations: Violation[]): string[][] {
  return violations.map((v) => v.labels);
}

describe("compileRules", () => {
  test("default config compiles without errors", () => {
    expect(errors).toEqual([]);
  });

  test("reports broken regexes instead of silently dropping them", () => {
    const result = compileRules([
      {
        displayName: "broken",
        match: { kind: "basename", names: ["x.md"] },
        policy: "p",
        patterns: [
          { label: "bad", regex: "([unclosed" },
          { label: "good", regex: "fine" },
        ],
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('edit-guard rule "broken"');
    expect(result.errors[0]).toContain("([unclosed");
    const brokenRule = result.rules[0];
    if (!brokenRule) throw new Error("rule missing");
    expect(brokenRule.rules.map((r) => r.label)).toEqual(["good"]);
  });

  test("allExcept placeholders expand against runtime roots", () => {
    const result = compileRules([
      {
        displayName: "not-under-notes",
        match: { kind: "allExcept", paths: ["{notesDir}"] },
        policy: "p",
        patterns: [{ label: "x", regex: "x" }],
      },
    ]);
    const rule = result.rules[0];
    if (!rule) throw new Error("rule missing");
    expect(rule.matches("/tmp/eg/notes/proj/file.md", roots)).toBe(false);
    expect(rule.matches("/tmp/eg/repo/src/file.md", roots)).toBe(true);
  });
});

describe("TODO.md rule", () => {
  const rules = todoRule.rules;

  test("matches the TODO.md basename, case-insensitively", () => {
    expect(todoRule.matches("/tmp/eg/anywhere/TODO.md", roots)).toBe(true);
    expect(todoRule.matches("/tmp/eg/anywhere/todo.md", roots)).toBe(true);
    expect(todoRule.matches("/tmp/eg/anywhere/NOTES.md", roots)).toBe(false);
  });

  test("flags done markers", () => {
    const hits = scanContent(
      [
        "- wire up the parser — DONE",
        "- **stage one**: DONE (helpers stubbed)",
        "1. ~~draft the plan~~ — DONE. see notes.",
        "- ~~old idea~~ **RESOLVED.** nothing to do.",
      ].join("\n"),
      rules,
    );
    expect(labelsOf(hits)).toEqual([
      ["DONE marker"],
      ["DONE marker"],
      ["DONE marker", "strikethrough"],
      ["RESOLVED marker", "strikethrough"],
    ]);
  });

  test("flags checkboxes", () => {
    expect(labelsOf(scanContent("- [x] finished task\n- [ ] open task\n5. [X] another done", rules))).toEqual([
      ["checked checkbox"],
      ["Markdown checkbox (TODO uses plain '- item')"],
      ["checked checkbox"],
    ]);
  });

  test("leaves legitimate lowercase prose alone", () => {
    expect(scanContent("the rest would be done in the next pass", rules)).toHaveLength(0);
    expect(scanContent("the first part is done, the rest remains", rules)).toHaveLength(0);
    expect(scanContent("waiting on the new version to unblock this", rules)).toHaveLength(0);
  });

  test("flags check glyphs and done tags", () => {
    expect(scanContent("✅ finished\n☑ also\n✓ third\n(done) last\n[Done] tagged", rules)).toHaveLength(5);
  });
});

describe("journal-reference rule", () => {
  const rules = journalRule.rules;

  test("applies to files outside private agent trees", () => {
    expect(journalRule.matches("/tmp/eg/repo/modules/foo.nix", roots)).toBe(true);
    expect(journalRule.matches("/tmp/eg/app/src/main.rs", roots)).toBe(true);
  });

  test("does not apply to notes, sessions, or agent-config trees", () => {
    expect(journalRule.matches("/tmp/eg/notes/proj/2027-01-02-03-topic.md", roots)).toBe(false);
    expect(journalRule.matches("/tmp/eg/notes/proj/TODO.md", roots)).toBe(false);
    expect(journalRule.matches("/tmp/eg/sessions/xyz/session.jsonl", roots)).toBe(false);
    expect(journalRule.matches("/tmp/eg/repo/config/llm/instructions.md", roots)).toBe(false);
    expect(journalRule.matches("/tmp/eg/repo/.pi/agents/foo.md", roots)).toBe(false);
  });

  test("flags journal paths and entry filenames", () => {
    expect(
      labelsOf(
        scanContent(
          [
            "fix details: 2027-01-02-03-example-topic.md",
            "see ~/notes/llm/proj/TODO.md for context",
            "// kept in sync with ~/notes/llm/proj/journal entries",
          ].join("\n"),
          rules,
        ),
      ),
    ).toEqual([["journal entry filename reference"], ["journal path reference"], ["journal path reference"]]);
  });

  test("leaves in-repo docs and normal dates alone", () => {
    expect(scanContent("see docs/setup.md for details", rules)).toHaveLength(0);
    expect(scanContent("CHANGES-2030-5.md", rules)).toHaveLength(0);
    expect(scanContent("since 2030-05-06 the server runs nightly", rules)).toHaveLength(0);
  });
});

describe("mergeRuleConfigs", () => {
  test("custom entry replaces the default with the same displayName, others append", () => {
    const replacement: RuleConfig = {
      displayName: "TODO.md",
      match: { kind: "basename", names: ["other.md"] },
      policy: "replacement policy",
      patterns: [{ label: "x", regex: "x" }],
    };
    const added: RuleConfig = {
      displayName: "extra",
      match: { kind: "basename", names: ["extra.md"] },
      policy: "added policy",
      patterns: [{ label: "y", regex: "y" }],
    };
    const merged = mergeRuleConfigs(DEFAULT_RULE_CONFIG, [replacement, added]);
    expect(merged.map((r) => r.displayName)).toEqual(["TODO.md", "public file", "internal codename", "extra"]);
    expect(merged[0]).toBe(replacement);
  });
});

describe("validateRuleConfig", () => {
  test("accepts every default rule", () => {
    for (const entry of DEFAULT_RULE_CONFIG) {
      expect(validateRuleConfig(entry, "defaults")).toBeNull();
    }
  });

  test("names the problem and source for bad entries", () => {
    expect(validateRuleConfig({ displayName: "x" }, "cfg[0]")).toContain("cfg[0]");
    expect(validateRuleConfig({ displayName: "x" }, "cfg[0]")).toContain("policy");
    expect(
      validateRuleConfig(
        {
          displayName: "",
          policy: "p",
          match: { kind: "basename", names: ["a.md"] },
          patterns: [{ label: "l", regex: "r" }],
        },
        "cfg",
      ),
    ).toContain("displayName");
    expect(
      validateRuleConfig(
        { displayName: "x", policy: "p", match: { kind: "nope" }, patterns: [{ label: "l", regex: "r" }] },
        "cfg",
      ),
    ).toContain("match.kind");
    expect(
      validateRuleConfig(
        { displayName: "x", policy: "p", match: { kind: "basename", names: ["a.md"] }, patterns: [] },
        "cfg",
      ),
    ).toContain("patterns");
  });
});

describe("internal-codename rule", () => {
  test("applies where the journal-reference rule applies", () => {
    expect(codenameRule.matches("/tmp/eg/repo/src/app.ts", roots)).toBe(true);
    expect(codenameRule.matches("/tmp/eg/notes/proj/2027-01-02-03-topic.md", roots)).toBe(false);
    expect(codenameRule.matches("/tmp/eg/repo/config/llm/instructions.md", roots)).toBe(false);
  });

  test("flags internal plan references, case-insensitively", () => {
    expect(labelsOf(scanContent("// see the plan for details", codenameRule.rules))).toEqual([
      ["internal plan reference"],
    ]);
    expect(scanContent("// The Plan says to merge these", codenameRule.rules)).toHaveLength(1);
  });

  test("leaves domain uses of plan alone", () => {
    expect(scanContent("// floor plan diagram lives in assets", codenameRule.rules)).toHaveLength(0);
    expect(scanContent("// delegate to the planner component", codenameRule.rules)).toHaveLength(0);
  });
});

describe("formatViolations", () => {
  test("includes header, >> context lines, and the policy", () => {
    const block = formatViolations(scanContent("- old thing — DONE", todoRule.rules), todoRule, "TODO.md");
    expect(block).toContain("[edit-guard TODO.md TODO.md: 1 suspect line]");
    expect(block).toContain(">> - old thing — DONE");
    expect(block).toContain(todoRule.policy);
  });

  test("caps listed lines and reports the remainder", () => {
    const violations = scanContent(
      Array.from({ length: 20 }, (_, i) => `- thing ${i} DONE`).join("\n"),
      todoRule.rules,
    );
    const block = formatViolations(violations, todoRule, "");
    expect(block).toContain("20 suspect lines");
    expect(block).toContain("... and 5 more");
  });
});
