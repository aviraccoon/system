import { describe, expect, test } from "bun:test";
import type { DecisionsAnswer } from "../shared/decisions";
import { DEFAULT_MESSAGE_THRESHOLD } from "../shared/review-message";
import { DEFAULT_VERDICT_THRESHOLDS } from "../shared/review-verdict";
import { formatGateNote, GATE_QUESTIONS, gateFromAnswers } from "./gate";

/** All four answered; overrides replace individual probabilities. */
function answers(overrides: Record<string, number> = {}): Record<string, DecisionsAnswer> {
  const defaults: Record<string, number> = {
    severity: 0.02,
    behavior: 0.02,
    unfinished: 0.01,
    message: 0.02,
  };
  const values = { ...defaults, ...overrides };
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, { type: "noul" as const, noul: value }]),
  );
}

describe("gate composition", () => {
  test("all four questions are asked in one request", () => {
    expect(Object.keys(GATE_QUESTIONS).sort()).toEqual(["behavior", "message", "severity", "unfinished"]);
  });

  test("a clean battery passes", () => {
    const outcome = gateFromAnswers(answers());
    expect(outcome?.blocking).toBe(false);
    expect(outcome?.reasons).toEqual([]);
  });

  test("a blocking verdict question passes the gate even when the message was judged", () => {
    const outcome = gateFromAnswers(answers({ severity: 0.97 }));
    expect(outcome?.blocking).toBe(true);
    expect(outcome?.reasons).toHaveLength(1);
    expect(outcome?.reasons[0]).toContain("severity 0.97 ≥");
  });

  test("a report that did not judge the message blocks on its own", () => {
    const outcome = gateFromAnswers(answers({ message: 0.91 }));
    expect(outcome?.blocking).toBe(true);
    expect(outcome?.reasons[0]).toContain("did not judge the proposed commit message (message 0.91");
  });

  test("both conditions fire together", () => {
    const outcome = gateFromAnswers(answers({ severity: 0.97, message: 0.91 }));
    expect(outcome?.reasons).toHaveLength(2);
  });

  test("a missing answer is null, which the caller treats as blocked", () => {
    const complete = answers();
    delete complete.message;
    expect(gateFromAnswers(complete)).toBeNull();
  });

  test("thresholds are per question", () => {
    expect(gateFromAnswers(answers({ message: 0.85 }), DEFAULT_VERDICT_THRESHOLDS, 0.9)?.blocking).toBe(false);
    expect(
      gateFromAnswers(answers({ message: 0.85 }), DEFAULT_VERDICT_THRESHOLDS, DEFAULT_MESSAGE_THRESHOLD)?.blocking,
    ).toBe(true);
  });
});

describe("gate note", () => {
  test("a null outcome reads as fail-closed, never clean", () => {
    const note = formatGateNote(null, "a".repeat(40));
    expect(note).toContain("blocked");
    expect(note).toContain("fail-closed");
    expect(note).not.toContain("clean");
  });

  test("a clean note shows every probability against its threshold", () => {
    const outcome = gateFromAnswers(answers());
    if (!outcome) throw new Error("expected a verdict");
    const note = formatGateNote(outcome, "b".repeat(40));
    expect(note).toContain("gate: clean for tree bbbbbbbb");
    expect(note).toContain(`message 0.02 < ${DEFAULT_MESSAGE_THRESHOLD.toFixed(2)}`);
    expect(note).toContain("severity 0.02 < 0.85");
  });

  test("a blocked note names the condition and the next action", () => {
    const outcome = gateFromAnswers(answers({ message: 0.91 }));
    if (!outcome) throw new Error("expected a verdict");
    const note = formatGateNote(outcome, "c".repeat(40));
    expect(note).toContain(`message 0.91 ≥ ${DEFAULT_MESSAGE_THRESHOLD.toFixed(2)}`);
    expect(note).toContain("`review` tool");
    expect(note).toContain("refused");
    expect(note).not.toContain("clean");
  });
});
