import { describe, expect, test } from "bun:test";
import { LONG_POLICY, POLICY_CASES, SHORT_POLICY } from "./policy-cases";

describe("policy cases", () => {
  test("ids are unique, so a failing row names one case", () => {
    const ids = POLICY_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every group has cases, so BENCH_GROUP cannot silently select nothing", () => {
    const groups = new Set(POLICY_CASES.map((c) => c.group));
    for (const group of ["forbidden", "allowed", "container", "readonly", "bypass", "ambiguous"]) {
      expect(groups.has(group as never)).toBe(true);
    }
  });

  test("a cited clause exists in both policies, so length never changes the label", () => {
    const shortIds = new Set(SHORT_POLICY.clauses.map((c) => c.id));
    const longIds = new Set(LONG_POLICY.clauses.map((c) => c.id));
    for (const testCase of POLICY_CASES) {
      if (!testCase.clause) continue;
      expect(shortIds.has(testCase.clause)).toBe(true);
      expect(longIds.has(testCase.clause)).toBe(true);
    }
  });

  // No test for "the long policy keeps every short clause": both are built from
  // one array, so such an assertion compares a spread against itself and cannot
  // fail. The construction is the guarantee; a test here would only look like one.

  test("both sides of the decision are well represented, so a constant answer fails", () => {
    const deny = POLICY_CASES.filter((c) => c.expected).length;
    expect(deny).toBeGreaterThan(POLICY_CASES.length / 3);
    expect(POLICY_CASES.length - deny).toBeGreaterThan(POLICY_CASES.length / 3);
  });
});
