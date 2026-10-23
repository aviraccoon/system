import { describe, expect, test } from "bun:test";
import type { DecisionsAnswer } from "./decisions";
import {
  DEFAULT_VERDICT_THRESHOLDS,
  hasAllVerdictAnswers,
  REVIEW_VERDICT_QUESTIONS,
  type VerdictQuestionName,
  verdictFromAnswers,
} from "./review-verdict";

const noul = (value: number): DecisionsAnswer => ({ type: "noul", noul: value });

function answers(values: Partial<Record<VerdictQuestionName, DecisionsAnswer>>): Record<string, DecisionsAnswer> {
  const base = Object.fromEntries(Object.keys(REVIEW_VERDICT_QUESTIONS).map((name) => [name, noul(0.02)]));
  return { ...base, ...values };
}

describe("verdict policy", () => {
  test("a missing answer is not clean", () => {
    const partial = answers({});
    delete partial.behavior;
    expect(hasAllVerdictAnswers(partial)).toBe(false);
    expect(verdictFromAnswers(partial)).toBeNull();
  });

  test("a custom threshold can flip the decision", () => {
    const severity = answers({ severity: noul(0.9) });
    expect(verdictFromAnswers(severity)?.blocking).toBe(true);
    const high = { severity: 0.95, behavior: 0.95, unfinished: 0.95 };
    expect(verdictFromAnswers(severity, high)?.blocking).toBe(false);
    expect(verdictFromAnswers(answers({ severity: noul(0.98) }), high)?.blocking).toBe(true);
  });

  test("the threshold is inclusive", () => {
    const verdict = verdictFromAnswers(answers({ severity: noul(DEFAULT_VERDICT_THRESHOLDS.severity) }));
    expect(verdict?.blocking).toBe(true);
    expect(verdict?.reasons.map((reason) => reason.name)).toEqual(["severity"]);
  });

  test("a clean verdict names no reasons", () => {
    const verdict = verdictFromAnswers(answers({}));
    expect(verdict?.blocking).toBe(false);
    expect(verdict?.reasons).toEqual([]);
  });

  test("several firing questions are all named, in battery order", () => {
    const verdict = verdictFromAnswers(answers({ severity: noul(0.98), unfinished: noul(0.97) }));
    expect(verdict?.reasons.map((reason) => reason.name)).toEqual(["severity", "unfinished"]);
  });
});
