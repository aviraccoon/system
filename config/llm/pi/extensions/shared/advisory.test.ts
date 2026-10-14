import { describe, expect, test } from "bun:test";
import {
  ADVICE_BLOCK_THRESHOLD,
  ADVICE_QUESTION,
  adviceBlockReason,
  adviceBlocks,
  adviceInterception,
  withAdvice,
} from "./advisory";

describe("advice", () => {
  test("blocks at or above the threshold, below does not", () => {
    expect(adviceBlocks(ADVICE_BLOCK_THRESHOLD)).toBe(true);
    expect(adviceBlocks(ADVICE_BLOCK_THRESHOLD - 0.01)).toBe(false);
    expect(adviceBlocks(1)).toBe(true);
    expect(adviceBlocks(0)).toBe(false);
  });

  test("the question is a noul with criteria on both sides", () => {
    expect(ADVICE_QUESTION.type).toBe("noul");
    if (ADVICE_QUESTION.type !== "noul" || !ADVICE_QUESTION.criteria) throw new Error("unexpected shape");
    expect(typeof ADVICE_QUESTION.criteria.true).toBe("string");
    expect(typeof ADVICE_QUESTION.criteria.false).toBe("string");
  });
});

describe("advice wiring", () => {
  test("interception fires only on an auto-allow above the threshold", () => {
    expect(adviceInterception(0.95, "allow")).not.toBeNull();
    expect(adviceInterception(0.95, "confirm")).toBeNull();
    expect(adviceInterception(0.95, "block")).toBeNull();
    expect(adviceInterception(0.5, "allow")).toBeNull();
    expect(adviceInterception(undefined, "allow")).toBeNull();
  });

  test("the block reason names the capture instruction", () => {
    expect(adviceBlockReason()).toContain("output-capture");
    expect(adviceBlockReason()).toContain("/tmp/<name>.log");
  });

  test("withAdvice appends the score to the detail", () => {
    const result = withAdvice({ verdict: "safe", short: "s", detail: "d" }, 0.42);
    expect(result.detail).toBe("d\nadvice 0.42");
    expect(result.verdict).toBe("safe");
  });
});
