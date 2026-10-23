/**
 * The review gate's message question: did the report actually judge the
 * proposed commit message?
 *
 * Separate from the three verdict questions because it is a different policy:
 * those ask whether the report's findings block, this asks whether the message
 * was covered at all. Both are asked in one classifier request, and the gate
 * blocks when either fires. The polarity matches the verdict battery: a true
 * answer means the problem is present.
 */

import type { DecisionsAnswer, DecisionsQuestion } from "./decisions";

/** Answer key in the gate's classifier request. */
export const MESSAGE_QUESTION_NAME = "message";

export const MESSAGE_JUDGED_QUESTION: DecisionsQuestion = {
  type: "noul",
  instructions:
    "Does this report fail to judge the proposed commit message? Judging means the report makes at least one verifiable claim about that message: whether its subject or body statements are supported by the diff, whether it follows the repository's conventions, or whether it is self-contained. A report that reviews only the code and never addresses the message fails. A report that says the message is fine, names a claim it cannot support, or states that an earlier round's message judgment still holds, judges it. A report that only quotes an earlier round's message verdict without asserting it still holds does not judge it.",
  criteria: {
    true: "The report never addresses the proposed commit message, or only quotes an earlier round's message verdict without asserting it still holds.",
    false:
      "The report makes at least one verifiable claim about the proposed commit message — its claims against the diff, its conventions, or its self-containment.",
  },
};

/** Starting point for the synthetic case set; re-run `benchmarks/message.ts` when a case or its wording changes. */
export const DEFAULT_MESSAGE_THRESHOLD = 0.65;

export interface MessageJudgment {
  /** True when the report did not judge the message. */
  failed: boolean;
  probability: number;
  threshold: number;
}

/** Null when the question did not answer: the caller must treat that as blocked. */
export function messageJudgmentFromAnswers(
  answers: Record<string, DecisionsAnswer>,
  threshold: number = DEFAULT_MESSAGE_THRESHOLD,
): MessageJudgment | null {
  const answer = answers[MESSAGE_QUESTION_NAME];
  if (answer?.type !== "noul") return null;
  return { failed: answer.noul >= threshold, probability: answer.noul, threshold };
}
