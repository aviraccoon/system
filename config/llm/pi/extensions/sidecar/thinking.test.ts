import { describe, expect, test } from "bun:test";
import type { ModelEntry } from "../shared/model-roles";
import {
  entryForAdd,
  entryThinking,
  hasEnableThinkingPin,
  nextThinking,
  THINKING_LEVELS,
  withoutEnableThinkingPin,
} from "./thinking";

// ── entryThinking ──

describe("entryThinking", () => {
  test("missing entry or level means off", () => {
    expect(entryThinking(undefined)).toBe("off");
    expect(entryThinking({ ref: "p/m" })).toBe("off");
  });

  test("keeps a configured level", () => {
    expect(entryThinking({ ref: "p/m", thinking: "high" })).toBe("high");
    expect(entryThinking({ ref: "p/m", thinking: "max" })).toBe("max");
  });

  test("an unknown level reads as off", () => {
    expect(entryThinking({ ref: "p/m", thinking: "turbo" } as unknown as ModelEntry)).toBe("off");
  });
});

// ── nextThinking ──

describe("nextThinking", () => {
  test("cycles the full set and wraps", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(nextThinking("off", THINKING_LEVELS)).toBe("minimal");
    expect(nextThinking("max", THINKING_LEVELS)).toBe("off");
  });

  test("skips levels the model does not support", () => {
    // deepseek-v4.1-flash-1017 maps minimal/medium/xhigh to null.
    const supported = ["off", "low", "high", "max"] as const;
    expect(nextThinking("off", supported)).toBe("low");
    expect(nextThinking("low", supported)).toBe("high");
    expect(nextThinking("max", supported)).toBe("off");
  });

  test("starts at the weakest level when the current one is unsupported", () => {
    expect(nextThinking("medium", ["off", "high"])).toBe("off");
  });

  test("orders by THINKING_LEVELS, not by the order given", () => {
    expect(nextThinking("low", ["high", "off", "low"])).toBe("high");
    // Last in the given order but weakest overall: the cycle must still move to low.
    expect(nextThinking("off", ["high", "low", "off"])).toBe("low");
  });

  test("a non-reasoning model stays put", () => {
    expect(nextThinking("off", ["off"])).toBe("off");
    expect(nextThinking("off", [])).toBe("off");
  });
});

// ── hasEnableThinkingPin ──

describe("hasEnableThinkingPin", () => {
  test("detects enable_thinking: false", () => {
    expect(
      hasEnableThinkingPin({ ref: "p/m", requestParams: { chat_template_kwargs: { enable_thinking: false } } }),
    ).toBe(true);
  });

  test("ignores enable_thinking: true and unrelated params", () => {
    expect(
      hasEnableThinkingPin({ ref: "p/m", requestParams: { chat_template_kwargs: { enable_thinking: true } } }),
    ).toBe(false);
    expect(hasEnableThinkingPin({ ref: "p/m", requestParams: { temperature: 0.7 } })).toBe(false);
    expect(hasEnableThinkingPin({ ref: "p/m" })).toBe(false);
    expect(hasEnableThinkingPin(undefined)).toBe(false);
  });

  test("ignores a non-object chat_template_kwargs", () => {
    expect(hasEnableThinkingPin({ ref: "p/m", requestParams: { chat_template_kwargs: "nope" } })).toBe(false);
  });
});

// ── withoutEnableThinkingPin ──

describe("withoutEnableThinkingPin", () => {
  test("drops only the pin and keeps sibling kwargs and params", () => {
    const entry = {
      ref: "p/m",
      thinking: "high" as const,
      requestParams: {
        temperature: 0.7,
        chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
      },
    };
    expect(withoutEnableThinkingPin(entry).requestParams).toEqual({
      temperature: 0.7,
      chat_template_kwargs: { preserve_thinking: true },
    });
  });

  test("drops chat_template_kwargs once it is empty", () => {
    const entry = { ref: "p/m", requestParams: { temperature: 0.7, chat_template_kwargs: { enable_thinking: false } } };
    expect(withoutEnableThinkingPin(entry).requestParams).toEqual({ temperature: 0.7 });
  });

  test("drops requestParams once nothing is left", () => {
    const entry = { ref: "p/m", requestParams: { chat_template_kwargs: { enable_thinking: false } } };
    expect(withoutEnableThinkingPin(entry).requestParams).toBeUndefined();
  });

  test("keeps the rest of the entry", () => {
    // The pin is present, so the drop branch actually runs.
    const entry = {
      ref: "p/m",
      thinking: "low" as const,
      maxAttempts: 2,
      requestParams: { temperature: 0.7, chat_template_kwargs: { enable_thinking: false } },
    };
    const next = withoutEnableThinkingPin(entry);
    expect(next.thinking).toBe("low");
    expect(next.maxAttempts).toBe(2);
    expect(next.requestParams).toEqual({ temperature: 0.7 });
  });

  test("does not mutate the input", () => {
    const entry = { ref: "p/m", requestParams: { chat_template_kwargs: { enable_thinking: false } } };
    withoutEnableThinkingPin(entry);
    expect(entry.requestParams).toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });
});

// ── entryForAdd ──

describe("entryForAdd", () => {
  test("reuses the configured entry so the level survives a re-add", () => {
    const configured = {
      ref: "omlx/qwen",
      thinking: "high" as const,
      maxAttempts: 2,
      requestParams: { temperature: 0.7 },
    };
    expect(entryForAdd(configured, "omlx/qwen")).toEqual(configured);
  });

  test("returns a copy, not the config object", () => {
    const configured = { ref: "p/m", thinking: "low" as const };
    expect(entryForAdd(configured, "p/m")).not.toBe(configured);
  });

  test("defaults a model with no saved entry to off", () => {
    expect(entryForAdd(undefined, "p/new")).toEqual({ ref: "p/new", thinking: "off" });
  });
});
