import { describe, expect, test } from "bun:test";
import type { DecisionsAnswer } from "./decisions";
import { DEFAULT_MESSAGE_THRESHOLD, MESSAGE_QUESTION_NAME, messageJudgmentFromAnswers } from "./review-message";

function answers(probability: number | null): Record<string, DecisionsAnswer> {
  if (probability === null) return {};
  return { [MESSAGE_QUESTION_NAME]: { type: "noul", noul: probability } };
}

describe("message judgment", () => {
  test("a missing answer is null, never a pass", () => {
    expect(messageJudgmentFromAnswers(answers(null))).toBeNull();
    expect(messageJudgmentFromAnswers({ message: { type: "choice", choice: "x", probabilities: {} } })).toBeNull();
  });

  test("below the threshold the message was judged", () => {
    const judgment = messageJudgmentFromAnswers(answers(0.3));
    expect(judgment).toEqual({ failed: false, probability: 0.3, threshold: DEFAULT_MESSAGE_THRESHOLD });
  });

  test("at the threshold the message was not judged", () => {
    expect(messageJudgmentFromAnswers(answers(DEFAULT_MESSAGE_THRESHOLD))?.failed).toBe(true);
  });

  test("a supplied threshold moves the decision", () => {
    expect(messageJudgmentFromAnswers(answers(0.85), 0.9)?.failed).toBe(false);
    expect(messageJudgmentFromAnswers(answers(0.85), 0.8)?.failed).toBe(true);
  });
});
