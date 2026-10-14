import { describe, expect, test } from "bun:test";
import { BLOCK_ONCE_ENTRY, BlockOnceSet } from "./block-once";
import { type CompiledPathRule, compileRules, DEFAULT_RULE_CONFIG } from "./rules";

const { rules, errors } = compileRules(DEFAULT_RULE_CONFIG);
if (errors.length > 0) throw new Error(`default rules failed to compile: ${errors.join("; ")}`);

function pick(displayName: string): CompiledPathRule {
  const rule = rules.find((r) => r.displayName === displayName);
  if (!rule) throw new Error(`missing expected default rule "${displayName}"`);
  return rule;
}

const inPlace = pick("in-place edit");
const pipe = pick("bash command");

describe("BlockOnceSet", () => {
  test("claims the rule's first matching command, then passes every later one", () => {
    const set = new BlockOnceSet();
    expect(set.claim(inPlace, "gsed -i 's/a/b/' file.ts")).not.toBeNull();
    expect(set.claim(inPlace, "gsed -i 's/a/b/' file.ts")).toBeNull();
    expect(set.claim(inPlace, "perl -0pi -e 's/x/y/' other.ts")).toBeNull();
    expect(set.names()).toEqual(["in-place edit"]);
  });

  test("returns the violations for the block reason", () => {
    const set = new BlockOnceSet();
    const violations = set.claim(inPlace, "cd src && sed -i '' 's/a/b/' file.ts");
    expect(violations?.map((v) => v.labels)).toEqual([["sed -i rewrites the file in place"]]);
  });

  test("ignores non-matching commands and rules that do not block", () => {
    const set = new BlockOnceSet();
    expect(set.claim(inPlace, "rg -n 'sed -i' .")).toBeNull();
    expect(set.claim(inPlace, "pnpm test 2>&1 | tail -5")).toBeNull();
    expect(set.claim(pipe, "cargo clippy | tail -20")).toBeNull();
    expect(set.names()).toEqual([]);
  });
});

describe("BlockOnceSet.restoreFromSession", () => {
  test("reads the session branch, not the compaction-filtered context", () => {
    const set = new BlockOnceSet();
    const source = {
      getBranch: () => [{ type: "custom", customType: BLOCK_ONCE_ENTRY, data: { blocked: "in-place edit" } }],
      buildContextEntries: () => [],
    };
    set.restoreFromSession(source);
    expect(set.names()).toEqual(["in-place edit"]);
    expect(set.claim(inPlace, "sed -i 's/a/b/' file.ts")).toBeNull();
  });

  test("a new session starts with nothing blocked", () => {
    const set = new BlockOnceSet();
    set.claim(inPlace, "sed -i 's/a/b/' file.ts");
    set.restoreFromSession({ getBranch: () => [] });
    expect(set.claim(inPlace, "sed -i 's/a/b/' file.ts")).not.toBeNull();
  });

  test("ignores entries that are not this extension's refusals", () => {
    const set = new BlockOnceSet();
    set.restoreFromSession({
      getBranch: () => [
        { type: "message" },
        { type: "custom", customType: "something_else", data: { blocked: "other rule" } },
        { type: "custom", customType: BLOCK_ONCE_ENTRY, data: { blocked: "in-place edit" } },
        { type: "custom", customType: BLOCK_ONCE_ENTRY, data: { blocked: 42 } },
      ],
    });
    expect(set.names()).toEqual(["in-place edit"]);
  });
});
