import { describe, expect, test } from "bun:test";
import { attemptPlan, isRetryable, MAX_ATTEMPTS } from "./retry";

describe("isRetryable", () => {
  test("retries a provider error even when output was produced", () => {
    expect(isRetryable({ stopReason: "error", exitCode: 1, messageCount: 4 })).toBe(true);
  });

  test("retries a child that never produced a message", () => {
    expect(isRetryable({ stopReason: undefined, exitCode: 1, messageCount: 0 })).toBe(true);
  });

  test("does not retry a user abort or a turn-budget stop", () => {
    expect(isRetryable({ stopReason: "aborted", exitCode: 1, messageCount: 3 })).toBe(false);
    expect(isRetryable({ stopReason: "max_turns_exceeded", exitCode: 0, messageCount: 30 })).toBe(false);
  });

  test("does not retry a completed run, even a non-zero exit with output", () => {
    expect(isRetryable({ stopReason: "stop", exitCode: 0, messageCount: 5 })).toBe(false);
    expect(isRetryable({ stopReason: "stop", exitCode: 1, messageCount: 2 })).toBe(false);
  });

  test("retries a natural stop that produced no answer", () => {
    expect(isRetryable({ stopReason: "stop", exitCode: 0, messageCount: 2, outputEmpty: true })).toBe(true);
  });

  test("an empty-output abort or turn-budget stop stays final", () => {
    expect(isRetryable({ stopReason: "aborted", exitCode: 1, messageCount: 2, outputEmpty: true })).toBe(false);
    expect(isRetryable({ stopReason: "max_turns_exceeded", exitCode: 0, messageCount: 30, outputEmpty: true })).toBe(
      false,
    );
  });

  test("outcomes without the flag keep the old verdict", () => {
    expect(isRetryable({ stopReason: "stop", exitCode: 0, messageCount: 3, outputEmpty: undefined })).toBe(false);
  });
});

describe("attemptPlan", () => {
  test("repeats the first model before moving down the chain", () => {
    expect(attemptPlan(["a", "b", "c", "d"])).toEqual(["a", "a", "b"] as string[]);
    expect(attemptPlan(["a", "b"])).toEqual(["a", "a", "b"] as string[]);
  });

  test("pads a short chain with its last entry so retries still happen", () => {
    expect(attemptPlan(["a"])).toEqual(["a", "a", "a"] as string[]);
  });

  test("no candidates, no attempts", () => {
    expect(attemptPlan([])).toEqual([] as string[]);
  });

  test("respects a custom budget", () => {
    expect(attemptPlan(["a", "b", "c"], 2)).toEqual(["a", "a"] as string[]);
    expect(attemptPlan(["a", "b", "c"], 6)).toEqual(["a", "a", "b", "b", "c", "c"] as string[]);
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
