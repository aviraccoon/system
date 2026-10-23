import { describe, expect, test } from "bun:test";
import type { DecisionsAnswer } from "./decisions";
import {
  DEFAULT_VERDICT_THRESHOLDS,
  formatVerdictNote,
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
    expect(formatVerdictNote(null)).toContain("fail-closed");
  });

  test("a custom threshold can flip the decision", () => {
    const severity = answers({ severity: noul(0.9) });
    expect(verdictFromAnswers(severity)?.blocking).toBe(true);
    const high = { severity: 0.95, behavior: 0.95, unfinished: 0.95 };
    expect(verdictFromAnswers(severity, high)?.blocking).toBe(false);
    const blocking = verdictFromAnswers(answers({ severity: noul(0.98) }), high);
    expect(formatVerdictNote(blocking)).toContain("0.95");
    const clean = verdictFromAnswers(answers({}), high);
    expect(formatVerdictNote(clean)).toContain("severity 0.02 < 0.95");
  });

  test("the threshold is inclusive", () => {
    const verdict = verdictFromAnswers(answers({ severity: noul(DEFAULT_VERDICT_THRESHOLDS.severity) }));
    expect(verdict?.blocking).toBe(true);
    expect(verdict?.reasons.map((reason) => reason.name)).toEqual(["severity"]);
  });

  test("a clean note names every probability and never reads as blocked", () => {
    const verdict = verdictFromAnswers(answers({}));
    expect(verdict?.blocking).toBe(false);
    const note = formatVerdictNote(verdict);
    expect(note).not.toContain("blocked");
    for (const name of Object.keys(REVIEW_VERDICT_QUESTIONS)) expect(note).toContain(`${name} 0.02`);
  });

  test("a blocking note names the condition and its probability", () => {
    const verdict = verdictFromAnswers(answers({ behavior: noul(0.96) }));
    const note = formatVerdictNote(verdict);
    expect(note).toContain("behavior 0.96 ≥ 0.85");
    expect(note).toContain("no pin that can fail");
    expect(note).toContain("not reviewed");
  });

  test("several firing questions are all named", () => {
    const verdict = verdictFromAnswers(answers({ severity: noul(0.98), unfinished: noul(0.97) }));
    expect(verdict?.reasons.map((reason) => reason.name)).toEqual(["severity", "unfinished"]);
    expect(formatVerdictNote(verdict)).toContain("did not finish");
  });
});
