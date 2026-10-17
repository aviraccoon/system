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

  test("enforce defaults to notice; a rule may opt into blockOnce", () => {
    expect(todoRule.enforce).toBe("notice");
    expect(pick("in-place edit").enforce).toBe("blockOnce");
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
    expect(scanContent("- parser notes — donegal sprint log", rules)).toHaveLength(0);
  });

  test("flags check glyphs and done tags", () => {
    expect(scanContent("✅ finished\n☑ also\n✓ third\n(done) last\n[Done] tagged", rules)).toHaveLength(5);
  });

  test("flags the trailing em-dash done annotation (reworded done item)", () => {
    expect(labelsOf(scanContent("- spike the parser — done.", rules))).toEqual([["done annotation (— done)"]]);
    expect(labelsOf(scanContent("- review pass — done, merged upstream", rules))).toEqual([
      ["done annotation (— done)"],
    ]);
  });

  test("flags commit hashes narrating landed work", () => {
    expect(labelsOf(scanContent("- follow-ups (core feature shipped in `cafebabe42`): remaining work", rules))).toEqual(
      [["commit hash reference"]],
    );
    expect(scanContent("- flip the default; the flag landed as `deadbee`", rules)).toHaveLength(1);
  });

  test("hash pattern catches digits-only hashes; long numeric ids flag too (advisory)", () => {
    expect(scanContent("- reclassify order `98765432101`", rules)).toHaveLength(1);
    expect(scanContent("- fix issue #479591 in the tracker", rules)).toHaveLength(0);
    expect(scanContent("- use color 0xff2049 in the theme", rules)).toHaveLength(0);
  });

  test("flags self-deleting and already-done lines", () => {
    expect(labelsOf(scanContent("- the temp export is already fixed — can delete", rules))).toEqual([
      ["self-deleting item (says it can be deleted)", "already-done claim"],
    ]);
  });

  test("flags wishlist markers (watch / consider / optional / if wanted)", () => {
    expect(
      labelsOf(
        scanContent(
          [
            "- Watch the upstream PR for the merge",
            "- watch for the next release",
            "- Consider renaming the parser",
            "- Optional: REPL mode for stepping",
            "- add a config flag if wanted",
            "- If wanted, keep Python",
          ].join("\n"),
          rules,
        ),
      ),
    ).toEqual([
      ["watch item"],
      ["watch item"],
      ["wishlist marker (consider)"],
      ["wishlist marker (optional)"],
      ["wishlist marker (if wanted)"],
      ["wishlist marker (if wanted)"],
    ]);
  });

  test("leaves wishlist-word lookalikes alone", () => {
    expect(scanContent("- the watchdog restarts the daemon", rules)).toHaveLength(0);
    expect(scanContent("- considered and rejected: the daemon route", rules)).toHaveLength(0);
    expect(scanContent("- the optionality is handled by the caller", rules)).toHaveLength(0);
  });

  test("leaves sanctioned journal links and future work alone", () => {
    expect(scanContent("- design agreed, spec: `2027-01-02-03-example-topic.md` — then implement", rules)).toHaveLength(
      0,
    );
    expect(scanContent("- ship the nightly build", rules)).toHaveLength(0);
    expect(scanContent("- decided: stay on the current stack", rules)).toHaveLength(0);
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
    expect(merged.map((r) => r.displayName)).toEqual([
      "TODO.md",
      "public file",
      "internal codename",
      "bash command",
      "in-place edit",
      "extra",
    ]);
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

  test("accepts enforce on bash rules, rejects unknown values and file rules", () => {
    const bashRule = {
      displayName: "x",
      policy: "p",
      match: { kind: "bash" },
      patterns: [{ label: "l", regex: "r" }],
    };
    expect(validateRuleConfig({ ...bashRule, enforce: "notice" }, "cfg")).toBeNull();
    expect(validateRuleConfig({ ...bashRule, enforce: "blockOnce" }, "cfg")).toBeNull();
    expect(validateRuleConfig({ ...bashRule, enforce: "always" }, "cfg")).toContain("enforce");
    expect(
      validateRuleConfig(
        {
          displayName: "x",
          policy: "p",
          match: { kind: "basename", names: ["a.md"] },
          enforce: "blockOnce",
          patterns: [{ label: "l", regex: "r" }],
        },
        "cfg",
      ),
    ).toContain("blockOnce");
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

describe("bash-command rule", () => {
  const bashRule = pick("bash command");
  const rules = bashRule.rules;

  test("is a bash-kind rule", () => {
    expect(bashRule.kind).toBe("bash");
  });

  test("flags output filtering and rg misuse", () => {
    expect(
      labelsOf(
        scanContent(["cargo clippy 2>&1 | tail -20", "rg -rn 'pattern' src/", "rg 'foo\\|bar' lib/"].join("\n"), rules),
      ),
    ).toEqual([
      ["output filtered through pipe"],
      ["rg -rn flag misuse (-r is --replace; this rewrites every match to 'n')"],
      ["rg escaped alternation (\\| matches a literal pipe, not OR)"],
    ]);
  });

  test("leaves plain commands alone", () => {
    expect(scanContent("rg 'foo|bar' src/", rules)).toHaveLength(0);
    expect(scanContent("cargo clippy", rules)).toHaveLength(0);
    expect(scanContent("rg foo src/ | wc -l", rules)).toHaveLength(0);
  });
});

describe("in-place-edit rule", () => {
  const bashRule = pick("in-place edit");
  const rules = bashRule.rules;

  test("is a bash-kind rule enforced once per session", () => {
    expect(bashRule.kind).toBe("bash");
    expect(bashRule.enforce).toBe("blockOnce");
  });

  test("flags sed and perl in-place rewrites", () => {
    expect(
      labelsOf(
        scanContent(
          [
            "gsed -i 's|old|new|' src/file.ts",
            "sed -i '' 's/foo/bar/' src/file.ts",
            "sed -E -i 's/foo/bar/' src/file.ts",
            "sudo sed --in-place 's/foo/bar/' /etc/hosts",
            "cd src && perl -i -pe 's/foo/bar/' file.ts",
            "perl -0pi -e 's/foo\\nbar/baz/' file.ts",
            "perl -pi.bak -e 's/foo/bar/' file.ts",
          ].join("\n"),
          rules,
        ),
      ),
    ).toEqual([
      ["sed -i rewrites the file in place"],
      ["sed -i rewrites the file in place"],
      ["sed -i rewrites the file in place"],
      ["sed -i rewrites the file in place"],
      ["perl -i rewrites the file in place"],
      ["perl -i rewrites the file in place"],
      ["perl -i rewrites the file in place"],
    ]);
  });

  test("leaves reads, mentions, and non-in-place interpreters alone", () => {
    expect(scanContent("rg -n 'sed -i' config/", rules)).toHaveLength(0);
    expect(scanContent("rg -n 'patch|sed -i' docs/", rules)).toHaveLength(0);
    expect(scanContent('rg "gsed|perl -i|sed -i" config/', rules)).toHaveLength(0);
    expect(scanContent("sed -n '1,60p' file.ts; rg -n -i pattern file.ts", rules)).toHaveLength(0);
    expect(scanContent("sed 's/foo/bar/' file.ts", rules)).toHaveLength(0);
    expect(scanContent("sed --expression 's/i/x/' file.ts", rules)).toHaveLength(0);
    expect(scanContent("perl -pe 's/\\e\\[[0-9;]*m//g' log.txt", rules)).toHaveLength(0);
    expect(scanContent("perl -MTime::HiRes -e 'print 1'", rules)).toHaveLength(0);
    expect(scanContent('git commit -m "switch sed -i for patch"', rules)).toHaveLength(0);
    expect(scanContent("echo 'perl -i'", rules)).toHaveLength(0);
  });
});

describe("formatViolations", () => {
  test("includes header, >> context lines, and the policy", () => {
    const block = formatViolations(scanContent("- old thing — DONE", todoRule.rules), todoRule, "TODO.md");
    expect(block).toContain("[edit-guard TODO.md TODO.md: 1 suspect line]");
    expect(block).toContain(">> - old thing — DONE");
    expect(block).toContain(todoRule.policy);
    // Literal, so deleting the wishlist sentence turns this pin red rather than
    // comparing the policy object to itself.
    expect(block).toContain("otherwise it belongs in the journal");
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
