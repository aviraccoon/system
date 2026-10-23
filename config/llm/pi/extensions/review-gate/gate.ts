/**
 * The gate decision: the three verdict questions plus the message question,
 * composed into one ledger record and one note.
 *
 * Two policies, one classifier request. A null outcome means a question did not
 * answer; the caller writes no entry, which blocks the commit.
 */

import type { DecisionsAnswer } from "../shared/decisions";
import {
  DEFAULT_MESSAGE_THRESHOLD,
  MESSAGE_JUDGED_QUESTION,
  MESSAGE_QUESTION_NAME,
  type MessageJudgment,
  messageJudgmentFromAnswers,
} from "../shared/review-message";
import {
  DEFAULT_VERDICT_THRESHOLDS,
  REVIEW_VERDICT_QUESTIONS,
  type ReviewVerdict,
  reviewReasonLabel,
  type VerdictThresholds,
  verdictFromAnswers,
} from "../shared/review-verdict";

export const GATE_QUESTIONS = {
  ...REVIEW_VERDICT_QUESTIONS,
  [MESSAGE_QUESTION_NAME]: MESSAGE_JUDGED_QUESTION,
};

export interface GateOutcome {
  blocking: boolean;
  /** One line per firing condition, for the ledger and the hook refusal. */
  reasons: string[];
  probabilities: Record<string, number>;
  verdict: ReviewVerdict;
  message: MessageJudgment;
}

function reasonLine(label: string, name: string, probability: number, threshold: number): string {
  return `${label} (${name} ${probability.toFixed(2)} ≥ ${threshold.toFixed(2)})`;
}

export function gateFromAnswers(
  answers: Record<string, DecisionsAnswer>,
  thresholds: VerdictThresholds = DEFAULT_VERDICT_THRESHOLDS,
  messageThreshold: number = DEFAULT_MESSAGE_THRESHOLD,
): GateOutcome | null {
  const verdict = verdictFromAnswers(answers, thresholds);
  const message = messageJudgmentFromAnswers(answers, messageThreshold);
  if (!verdict || !message) return null;
  const reasons = verdict.reasons.map((reason) =>
    reasonLine(reviewReasonLabel(reason.name), reason.name, reason.probability, reason.threshold),
  );
  if (message.failed) {
    reasons.push(
      reasonLine(
        "a report that did not judge the proposed commit message",
        MESSAGE_QUESTION_NAME,
        message.probability,
        message.threshold,
      ),
    );
  }
  return {
    blocking: verdict.blocking || message.failed,
    reasons,
    probabilities: { ...verdict.probabilities, [MESSAGE_QUESTION_NAME]: message.probability },
    verdict,
    message,
  };
}

/**
 * The one line the agent sees. It names the condition and the number that
 * fired, not a synthesized finding: the report already holds the finding, and a
 * paraphrase would send the agent after the wrong text. A null outcome is
 * reported as fail-closed, never as clean.
 */
export function formatGateNote(outcome: GateOutcome | null, tree?: string): string {
  const where = tree ? ` for tree ${tree.slice(0, 8)}` : "";
  if (!outcome) {
    return `gate: blocked${where} — the classifier did not answer every question; fail-closed, no review recorded. Re-dispatch.`;
  }
  const numbers = [
    `${MESSAGE_QUESTION_NAME} ${outcome.message.probability.toFixed(2)} < ${outcome.message.threshold.toFixed(2)}`,
    ...Object.entries(outcome.verdict.thresholds).map(
      ([name, threshold]) => `${name} ${outcome.probabilities[name].toFixed(2)} < ${threshold.toFixed(2)}`,
    ),
  ].join(", ");
  if (!outcome.blocking) return `gate: clean${where} (${numbers}).`;
  return `gate: blocked${where} — ${outcome.reasons.join("; ")}. Address it and re-dispatch; this tree is not reviewed.`;
}
