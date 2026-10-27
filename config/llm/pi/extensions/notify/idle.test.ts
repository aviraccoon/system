import { describe, expect, test } from "bun:test";
import { away, DEFAULT_POLICY, parseHidIdleSeconds, pushBlocked, pushSettled, readPolicy } from "./idle";

describe("parseHidIdleSeconds", () => {
  test("reads nanoseconds and converts to seconds", () => {
    const output = '    | | |   "HIDIdleTime" = 7341240208\n';
    expect(parseHidIdleSeconds(output)).toBeCloseTo(7.34, 2);
  });

  test("output without the key is unknown", () => {
    expect(parseHidIdleSeconds("no idle time here")).toBeNull();
  });

  test("a non-numeric value is unknown", () => {
    expect(parseHidIdleSeconds('"HIDIdleTime" = abc')).toBeNull();
  });
});

describe("readPolicy", () => {
  test("defaults when the environment is empty", () => {
    expect(readPolicy({})).toEqual(DEFAULT_POLICY);
  });

  test("seconds are read from the environment", () => {
    expect(readPolicy({ PI_NOTIFY_IDLE_SECONDS: "5", PI_NOTIFY_MIN_RUN_SECONDS: "30" })).toEqual({
      idleSeconds: 5,
      minRunMs: 30_000,
    });
  });

  test("zero is a real value, not a fallback", () => {
    expect(readPolicy({ PI_NOTIFY_IDLE_SECONDS: "0" }).idleSeconds).toBe(0);
  });

  test("malformed and negative values keep the default", () => {
    expect(readPolicy({ PI_NOTIFY_IDLE_SECONDS: "soon", PI_NOTIFY_MIN_RUN_SECONDS: "-3" })).toEqual(DEFAULT_POLICY);
  });

  test("an empty value keeps the default", () => {
    expect(readPolicy({ PI_NOTIFY_IDLE_SECONDS: "  " }).idleSeconds).toBe(DEFAULT_POLICY.idleSeconds);
  });
});

describe("away", () => {
  test("unknown idle time counts as away", () => {
    expect(away(null, DEFAULT_POLICY)).toBe(true);
  });

  test("the threshold itself counts as away", () => {
    expect(away(DEFAULT_POLICY.idleSeconds, DEFAULT_POLICY)).toBe(true);
  });

  test("recent input means present", () => {
    expect(away(DEFAULT_POLICY.idleSeconds - 1, DEFAULT_POLICY)).toBe(false);
  });
});

describe("pushBlocked", () => {
  test("follows the away rule", () => {
    expect(pushBlocked(0, DEFAULT_POLICY)).toBe(false);
    expect(pushBlocked(3600, DEFAULT_POLICY)).toBe(true);
  });
});

describe("pushSettled", () => {
  const policy = DEFAULT_POLICY;

  test("a long run with nobody at the keyboard", () => {
    expect(pushSettled(policy.minRunMs, 3600, policy)).toBe(true);
  });

  test("a short run is not worth a push even when away", () => {
    expect(pushSettled(policy.minRunMs - 1, 3600, policy)).toBe(false);
  });

  test("a long run finished at the keyboard is not worth a push", () => {
    expect(pushSettled(policy.minRunMs * 2, 0, policy)).toBe(false);
  });
});
