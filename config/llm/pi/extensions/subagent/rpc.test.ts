import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents";
import {
  attemptOutcome,
  exitStopReason,
  finalAnswerText,
  resolveAgentTargets,
  resultFailed,
  type SingleResult,
} from "./rpc";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function result(overrides: Partial<SingleResult> & { messages: Message[] }): SingleResult {
  return { agent: "reviewer", agentSource: "user", task: "t", exitCode: 0, stderr: "", usage, ...overrides };
}

function assistant(...parts: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>): Message {
  return { role: "assistant", content: parts } as unknown as Message;
}

describe("finalAnswerText", () => {
  test("joins the last assistant message's own text parts", () => {
    const messages = [
      assistant({ type: "text", text: "earlier narration" }),
      assistant(
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "the " },
        { type: "text", text: "answer" },
      ),
    ];
    expect(finalAnswerText(messages)).toBe("the answer");
  });

  test("a text-less stopping message is empty, not an earlier turn's text", () => {
    const messages = [
      assistant({ type: "text", text: "earlier narration" }),
      assistant({ type: "thinking", thinking: "plan" }),
    ];
    expect(finalAnswerText(messages)).toBe("");
  });
});

describe("attemptOutcome", () => {
  test("empty output only when the stopping message has no text", () => {
    const narrated = result({
      stopReason: "stop",
      messages: [
        assistant({ type: "text", text: "earlier narration" }),
        assistant({ type: "thinking", thinking: "plan" }),
      ],
    });
    expect(attemptOutcome(narrated).outputEmpty).toBe(true);
    const answered = result({ stopReason: "stop", messages: [assistant({ type: "text", text: "findings" })] });
    expect(attemptOutcome(answered).outputEmpty).toBe(false);
  });

  test("carries stopReason, exitCode and messageCount through", () => {
    const r = result({ stopReason: "stop", exitCode: 0, messages: [assistant({ type: "text", text: "ok" })] });
    const outcome = attemptOutcome(r);
    expect(outcome.stopReason).toBe("stop");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.messageCount).toBe(1);
  });
});

describe("resultFailed", () => {
  test("a natural stop with an answer is success", () => {
    const r = result({ stopReason: "stop", messages: [assistant({ type: "text", text: "findings" })] });
    expect(resultFailed(r)).toBe(false);
  });

  test("a silent natural stop is failure", () => {
    const r = result({ stopReason: "stop", messages: [assistant({ type: "thinking", thinking: "plan" })] });
    expect(resultFailed(r)).toBe(true);
  });

  test("error and turn-budget stops are failure, running is not", () => {
    expect(resultFailed(result({ stopReason: "error", messages: [] }))).toBe(true);
    expect(resultFailed(result({ stopReason: "max_turns_exceeded", messages: [] }))).toBe(true);
    expect(resultFailed(result({ exitCode: -1, messages: [] }))).toBe(false);
  });
});

describe("exitStopReason", () => {
  test("a user abort before agent_end marks the run aborted", () => {
    expect(exitStopReason(false, true, false, undefined)).toBe("aborted");
  });

  test("an abort after agent_end is cleanup, not the outcome", () => {
    expect(exitStopReason(false, true, true, "stop")).toBe("stop");
  });

  test("a turn-capped run reports max_turns_exceeded unless it genuinely stopped", () => {
    expect(exitStopReason(true, false, false, "stop")).toBe("stop");
    expect(exitStopReason(true, true, true, undefined)).toBe("max_turns_exceeded");
  });

  test("a natural close keeps the run's own stop reason", () => {
    expect(exitStopReason(false, false, false, "stop")).toBe("stop");
    expect(exitStopReason(false, false, false, undefined)).toBeUndefined();
  });
});

describe("resolveAgentTargets", () => {
  // Only a pinned-model agent is exercised here: the role path reads roles.json from
  // disk and resolves auth through the real registry, which a unit test cannot pin.
  const pinned = (model: string, thinking?: string): AgentConfig => ({
    name: "pinned",
    description: "One model",
    model,
    thinking,
    source: "user",
    filePath: "/fake/pinned.md",
    systemPrompt: "",
  });

  function ctx(registry: { found?: boolean; authed?: boolean }): ExtensionContext {
    return {
      modelRegistry: {
        find: () => (registry.found === false ? undefined : { provider: "openrouter", id: "x/y" }),
        getApiKeyAndHeaders: async () =>
          registry.authed === false ? { ok: false } : { ok: true, apiKey: "k", headers: undefined },
      },
    } as unknown as ExtensionContext;
  }

  test("a catalogued, authenticated pinned model becomes the single target", async () => {
    const result = await resolveAgentTargets(pinned("openrouter/x/y", "high"), ctx({}));
    expect(result.error).toBeUndefined();
    expect(result.targets).toEqual([{ ref: "openrouter/x/y", thinking: "high" }]);
  });

  test("a ref the catalog does not carry is a config error, not a spawn", async () => {
    const result = await resolveAgentTargets(pinned("openrouter/x/y"), ctx({ found: false }));
    expect(result.targets).toEqual([]);
    expect(result.error).toContain("not in the model catalog");
    expect(result.error).toContain("openrouter/x/y");
  });

  test("a ref with no provider is rejected the same way", async () => {
    const result = await resolveAgentTargets(pinned("x-y"), ctx({}));
    expect(result.error).toContain("not in the model catalog");
  });

  test("an unauthenticated provider is named rather than left to the child", async () => {
    const result = await resolveAgentTargets(pinned("openrouter/x/y"), ctx({ authed: false }));
    expect(result.targets).toEqual([]);
    expect(result.error).toContain('provider "openrouter" has no credentials');
  });
});
