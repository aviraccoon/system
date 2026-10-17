import { describe, expect, test } from "bun:test";
import { type ChainEntry, DEFAULT_SUBAGENT_ROLE, planAgentTargets, type TargetSpec, targetArgs } from "./target";

const chain: ChainEntry[] = [
  { ref: "openrouter/deepseek/deepseek-v4.1-flash", thinking: "high" },
  { ref: "zai/glm-5.3-flash", thinking: "off" },
];

function spec(overrides: Partial<TargetSpec> = {}): TargetSpec {
  return { name: "researcher", ...overrides };
}

describe("planAgentTargets", () => {
  test("a pinned model wins over a role and carries its own level", () => {
    const result = planAgentTargets(spec({ model: "omlx/Qwen3.8-27B-4bit", role: "explain", thinking: "low" }), chain);
    expect(result.error).toBeUndefined();
    expect(result.targets).toEqual([{ ref: "omlx/Qwen3.8-27B-4bit", thinking: "low" }]);
    // A pinned model has no chain, so nothing names a role for the result header.
    expect(result.role).toBeUndefined();
  });

  test("a pinned model with no level leaves pi's default in place", () => {
    expect(planAgentTargets(spec({ model: "openrouter/x/y" }), chain).targets).toEqual([{ ref: "openrouter/x/y" }]);
  });

  test("a chain keeps each entry's own level", () => {
    expect(planAgentTargets(spec({ role: "explain" }), chain)).toEqual({
      role: "explain",
      targets: [
        { ref: "openrouter/deepseek/deepseek-v4.1-flash", thinking: "high" },
        { ref: "zai/glm-5.3-flash", thinking: "off" },
      ],
    });
  });

  test("thinking: overrides every attempt of a chain", () => {
    const result = planAgentTargets(spec({ role: "explain", thinking: "max" }), chain);
    expect(result.targets.map((t) => t.thinking)).toEqual(["max", "max"]);
  });

  test("no role and no model resolves the default role", () => {
    const result = planAgentTargets(spec(), chain);
    expect(result.role).toBe(DEFAULT_SUBAGENT_ROLE);
    expect(result.targets).toEqual(chain.map((entry) => ({ ref: entry.ref, thinking: entry.thinking })));
  });

  test("an absent default role falls back to pi's defaults, not an error", () => {
    expect(planAgentTargets(spec(), [])).toEqual({ targets: [] });
  });

  test("an explicitly named role with no available model is an error", () => {
    const result = planAgentTargets(spec({ role: "explain" }), []);
    expect(result.targets).toEqual([]);
    expect(result.role).toBe("explain");
    expect(result.error).toContain('Role "explain"');
  });

  test("an unknown thinking level is an error naming the agent and the valid levels", () => {
    const result = planAgentTargets(spec({ role: "explain", thinking: "highest" }), chain);
    expect(result.targets).toEqual([]);
    expect(result.error).toContain('Agent "researcher"');
    expect(result.error).toContain('"highest"');
    expect(result.error).toContain("xhigh");
    // The error result names the role, so the header is not bare.
    expect(result.role).toBe("explain");
  });

  test("an unknown level on a pinned model points at the ref instead of a role", () => {
    const result = planAgentTargets(spec({ model: "openrouter/x/y", thinking: "nope" }), chain);
    expect(result.role).toBeUndefined();
  });

  test("the invalid level is reported even for a pinned model", () => {
    const result = planAgentTargets(spec({ model: "openrouter/x/y", thinking: "nope" }), chain);
    expect(result.targets).toEqual([]);
    expect(result.error).toContain('"nope"');
  });

  test("a valid level is not flagged when the chain is empty", () => {
    const result = planAgentTargets(spec({ thinking: "low" }), []);
    expect(result.error).toBeUndefined();
    expect(result.targets).toEqual([]);
  });
});

describe("targetArgs", () => {
  test("passes the model and its level to the child", () => {
    expect(targetArgs({ ref: "openrouter/x/y", thinking: "high" })).toEqual([
      "--model",
      "openrouter/x/y",
      "--thinking",
      "high",
    ]);
  });

  test("an unset level passes no --thinking, leaving pi's own default", () => {
    expect(targetArgs({ ref: "openrouter/x/y" })).toEqual(["--model", "openrouter/x/y"]);
  });
});
