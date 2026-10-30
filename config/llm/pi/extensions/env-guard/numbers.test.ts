import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY_THRESHOLD } from "../shared/env-policy";
import { guardNumbers } from "./numbers";

describe("guardNumbers", () => {
  test("both unset uses the defaults and says nothing", () => {
    expect(guardNumbers({})).toEqual({ threshold: DEFAULT_POLICY_THRESHOLD, timeoutMs: 10_000, warnings: [] });
  });

  test("a usable threshold and timeout are kept", () => {
    const numbers = guardNumbers({ PI_GUARD_THRESHOLD: "0.5", PI_GUARD_TIMEOUT_MS: "2500" });
    expect(numbers.threshold).toBe(0.5);
    expect(numbers.timeoutMs).toBe(2500);
    expect(numbers.warnings).toEqual([]);
  });

  test("a threshold of exactly 1 is usable", () => {
    expect(guardNumbers({ PI_GUARD_THRESHOLD: "1" }).threshold).toBe(1);
  });

  // One row per way the value stops meaning a probability. Each must fall back and warn,
  // because both directions change refusal behaviour without any visible trace.
  const badThresholds = ["", " ", "0", "-1", "NaN", "70", "1.5", "abc"];
  for (const raw of badThresholds) {
    test(`threshold ${JSON.stringify(raw)} falls back and warns`, () => {
      const numbers = guardNumbers({ PI_GUARD_THRESHOLD: raw });
      expect(numbers.threshold).toBe(DEFAULT_POLICY_THRESHOLD);
      expect(numbers.warnings.join("\n")).toContain("PI_GUARD_THRESHOLD");
    });
  }

  const badTimeouts = ["", "0", "-5", "NaN"];
  for (const raw of badTimeouts) {
    test(`timeout ${JSON.stringify(raw)} falls back and warns`, () => {
      const numbers = guardNumbers({ PI_GUARD_TIMEOUT_MS: raw });
      expect(numbers.timeoutMs).toBe(10_000);
      expect(numbers.warnings.join("\n")).toContain("PI_GUARD_TIMEOUT_MS");
    });
  }

  test("both bad values are reported, not just the first", () => {
    const numbers = guardNumbers({ PI_GUARD_THRESHOLD: "0", PI_GUARD_TIMEOUT_MS: "0" });
    expect(numbers.warnings.length).toBe(2);
  });
});
