/**
 * Review-verdict questions and the policy that turns their answers into a
 * commit decision.
 *
 * Three independent questions rather than one conjunction: a single "should
 * this block?" question let a MINOR behavior change and an unfinished review
 * read as clean, because "MINOR" and "ran out of budget" diluted the whole.
 * Each condition has its own threshold, and a firing answer names the reason.
 *
 * Missing answers are not "nothing fired": the caller must treat a null as a
 * blocked commit (the gate fails closed), matching the factor battery.
 */

import type { DecisionsAnswer, DecisionsQuestion } from "./decisions";

const noul = (instructions: string, criteria: { true: string; false: string }): DecisionsQuestion => ({
  type: "noul",
  instructions,
  criteria,
});

const QUESTION_NAMES = ["severity", "behavior", "unfinished"] as const;
export type VerdictQuestionName = (typeof QUESTION_NAMES)[number];

export const REVIEW_VERDICT_QUESTIONS: Record<VerdictQuestionName, DecisionsQuestion> = {
  severity: noul(
    'Does this code-review report contain an unresolved, in-scope finding graded CRITICAL or MAJOR? A finding the report marks as out of scope or already fixed does not count. A quoted earlier finding that the report says is resolved does not count. A CRITICAL or MAJOR finding is never declined, so a report that says it is declined still counts. A report that lists a CRITICAL or MAJOR finding and also says "no findings" still lists it.',
    {
      true: "An unresolved in-scope CRITICAL or MAJOR finding.",
      false:
        "No such finding: clean, or every finding is a NIT or a MINOR that is not a behavior finding, out of scope, or fixed.",
    },
  ),
  behavior: noul(
    "Does this code-review report contain an unresolved, in-scope finding that changes observable behavior with no test that asserts the new behavior and would fail if reverted, returns a wrong result, or breaks an invariant? A behavior change covered by a test that asserts the new behavior counts as pinned, not as this finding. A test that still asserts the old behavior and now fails is not a pin. A prose, docs, or style finding does not count. A finding the report marks as out of scope or already fixed does not count. A behavior finding is never declined, so a report that says it is declined still counts.",
    {
      true: "An in-scope behavior change with no test asserting the new behavior, a wrong result, or a broken invariant, whatever its grade — even a MINOR counts.",
      false:
        "Only prose, docs, or style findings; behavior changes pinned by a test asserting the new behavior; or behavior findings that are out of scope or fixed.",
    },
  ),
  unfinished: noul(
    "Did this review fail to finish — did it run out of budget, leave part of the change unread, or reach no conclusion (an empty or truncated report)? A stated verification gap in a finished review — material outside the changed set, such as a live service or an external document — does not count as unfinished when the report otherwise reaches a conclusion. A changed file the report says it could not read is part of the change, so the review did not finish.",
    {
      true: "The report says it ran out of budget, stopped early, left part of the change unreviewed (including a changed file it could not read), or it is empty or truncated with no conclusion.",
      false: "The review finished, and any stated gap is outside the changed set.",
    },
  ),
};

export type VerdictThresholds = Record<VerdictQuestionName, number>;

/**
 * Starting point for the synthetic case set, not a calibration constant.
 * Re-check with `benchmarks/verdict.ts` when a question or its cases change.
 */
export const DEFAULT_VERDICT_THRESHOLDS: VerdictThresholds = {
  severity: 0.85,
  behavior: 0.85,
  unfinished: 0.85,
};

export interface ReviewVerdictReason {
  name: VerdictQuestionName;
  probability: number;
  /** The threshold this reason was judged against. */
  threshold: number;
}

export interface ReviewVerdict {
  blocking: boolean;
  /** Questions at or above their threshold, with the numbers behind the call. */
  reasons: ReviewVerdictReason[];
  probabilities: Record<VerdictQuestionName, number>;
  /** The thresholds this verdict was judged against. */
  thresholds: VerdictThresholds;
}

/** Every question answered: a partial set must not read as "nothing fired". */
export function hasAllVerdictAnswers(answers: Record<string, DecisionsAnswer>): boolean {
  return QUESTION_NAMES.every((name) => answers[name]?.type === "noul");
}

function verdictProbabilities(answers: Record<string, DecisionsAnswer>): Record<VerdictQuestionName, number> {
  const probabilities = {} as Record<VerdictQuestionName, number>;
  for (const name of QUESTION_NAMES) {
    const answer = answers[name];
    probabilities[name] = answer?.type === "noul" ? answer.noul : 0;
  }
  return probabilities;
}

/** A null means the caller must not act on a partial answer. */
export function verdictFromAnswers(
  answers: Record<string, DecisionsAnswer>,
  thresholds: VerdictThresholds = DEFAULT_VERDICT_THRESHOLDS,
): ReviewVerdict | null {
  if (!hasAllVerdictAnswers(answers)) return null;
  const probabilities = verdictProbabilities(answers);
  const reasons = QUESTION_NAMES.filter((name) => probabilities[name] >= thresholds[name]).map((name) => ({
    name,
    probability: probabilities[name],
    threshold: thresholds[name],
  }));
  return { blocking: reasons.length > 0, reasons, probabilities, thresholds };
}

const REASON_LABELS: Record<VerdictQuestionName, string> = {
  severity: "an unresolved in-scope CRITICAL/MAJOR finding",
  behavior: "an in-scope behavior change with no pin that can fail",
  unfinished: "a review that did not finish",
};

/** The human label for a question, for callers that compose their own note. */
export function reviewReasonLabel(name: VerdictQuestionName): string {
  return REASON_LABELS[name];
}
