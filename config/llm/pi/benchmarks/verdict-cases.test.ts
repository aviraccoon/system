import { describe, expect, test } from "bun:test";
import { isBlocked, passes, scoreAt, sweep, VERDICT_CASES, type VerdictRow } from "./verdict-cases";

function row(expected: boolean, pBlocking: number | null): VerdictRow {
  return { id: "x", group: "clean", expected, pBlocking, ms: 1, cost: 0 };
}

describe("cases", () => {
  test("ids are unique and every case has an input string", () => {
    const ids = VERDICT_CASES.map((test) => test.id);
    expect(new Set(ids).size).toBe(ids.length);
    const empty = VERDICT_CASES.filter((test) => test.input.trim().length === 0).map((test) => test.id);
    expect(empty).toEqual(["empty-report"]);
  });

  test("every group is represented", () => {
    const groups = new Set(VERDICT_CASES.map((test) => test.group));
    expect([...groups].sort()).toEqual([
      "behavior",
      "blocking",
      "clean",
      "incomplete",
      "nit",
      "out-of-scope",
      "quoted",
    ]);
  });

  test("a finding that is quoted, out of scope, or only a NIT is not blocking", () => {
    for (const test of VERDICT_CASES) {
      if (test.group === "quoted" || test.group === "out-of-scope" || test.group === "nit") {
        expect(test.expected).toBe(false);
      }
      if (test.group === "blocking" || test.group === "incomplete") {
        expect(test.expected).toBe(true);
      }
    }
  });

  test("a behavior finding can be either side of the decision", () => {
    const behavior = VERDICT_CASES.filter((test) => test.group === "behavior");
    expect(behavior.some((test) => test.expected)).toBe(true);
    expect(behavior.some((test) => !test.expected)).toBe(true);
  });

  test("the set carries cases on both sides of the decision", () => {
    const blocking = VERDICT_CASES.filter((test) => test.expected).length;
    expect(blocking).toBeGreaterThan(0);
    expect(blocking).toBeLessThan(VERDICT_CASES.length);
  });
});

describe("scoring", () => {
  test("a failed call blocks, matching the gate", () => {
    expect(isBlocked({ pBlocking: null }, 0.9)).toBe(true);
    expect(isBlocked({ pBlocking: 0.95 }, 0.9)).toBe(true);
    expect(isBlocked({ pBlocking: 0.6 }, 0.9)).toBe(false);
  });

  test("false pass and false block are counted apart", () => {
    const rows = [
      row(true, 0.95), // true positive
      row(true, 0.2), // false pass
      row(false, 0.1), // true negative
      row(false, 0.95), // false block
      row(false, null), // error, blocked but not a policy false block
    ];
    const score = scoreAt(rows, 0.9);
    expect(score.truePositive).toBe(1);
    expect(score.falsePass).toBe(1);
    expect(score.trueNegative).toBe(1);
    expect(score.falseBlock).toBe(1);
    expect(score.errors).toBe(1);
    expect(passes(row(true, 0.95), 0.9)).toBe(true);
    expect(passes(row(true, 0.2), 0.9)).toBe(false);
  });

  test("a stored per-question decision beats the max probability", () => {
    const divergent = { ...row(true, 0.2), blocking: true };
    expect(passes(divergent, 0.9)).toBe(true);
    expect(scoreAt([divergent], 0.9).truePositive).toBe(1);
  });

  test("the sweep covers 0.50 through 0.95", () => {
    const scores = sweep([]);
    expect(scores).toHaveLength(10);
    expect(scores[0]?.threshold).toBe(0.5);
    expect(scores[9]?.threshold).toBe(0.95);
  });
});
