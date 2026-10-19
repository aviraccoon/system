import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents";
import {
  attemptOutcome,
  chainStreamWarning,
  childRetryPending,
  exitStopReason,
  finalAnswerText,
  mergeAttemptMessages,
  resolveAgentTargets,
  resultFailed,
  type SingleResult,
  streamErrorSuffix,
  withChainWarnings,
  withStreamWarning,
} from "./rpc";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };

function result(overrides: Partial<SingleResult> & { messages: Message[] }): SingleResult {
  return { agent: "reviewer", agentSource: "user", task: "t", exitCode: 0, stderr: "", usage, ...overrides };
}

function assistant(...parts: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>): Message {
  return { role: "assistant", content: parts } as unknown as Message;
}

const toolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "bash",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 0,
} as unknown as Message;

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

  test("a trailing tool result does not hide the answer", () => {
    // The handler appends a retrying run's tool results to the batch, so the
    // verdict has to read the newest assistant message, not the last element.
    const messages = [assistant({ type: "text", text: "findings" }), toolResult];
    expect(finalAnswerText(messages)).toBe("findings");
    const r = result({ stopReason: "error", errorMessage: "Network connection lost.", messages });
    expect(resultFailed(r)).toBe(false);
    expect(attemptOutcome(r).outputEmpty).toBe(false);
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

  test("an empty errored stop and a turn-budget stop are failure, running is not", () => {
    expect(resultFailed(result({ stopReason: "error", messages: [] }))).toBe(true);
    expect(resultFailed(result({ stopReason: "max_turns_exceeded", messages: [] }))).toBe(true);
    expect(resultFailed(result({ exitCode: -1, messages: [] }))).toBe(false);
  });

  test("an error after the answer arrived is delivered, not failed", () => {
    const r = result({
      stopReason: "error",
      errorMessage: "Network connection lost.",
      messages: [assistant({ type: "text", text: "## Findings" })],
    });
    expect(resultFailed(r)).toBe(false);
  });

  test("an abort mid-run is a failure even with text written", () => {
    const r = result({ stopReason: "aborted", messages: [assistant({ type: "text", text: "so far" })] });
    expect(resultFailed(r)).toBe(true);
  });
});

describe("streamErrorSuffix", () => {
  test("names the stream error on a delivered answer", () => {
    const r = result({
      stopReason: "error",
      errorMessage: "Network connection lost.",
      messages: [assistant({ type: "text", text: "findings" })],
    });
    expect(streamErrorSuffix(r)).toContain("stream ended early: Network connection lost.");
  });

  test("is empty for a clean run, a failed run, or a non-error stop", () => {
    const clean = result({ stopReason: "stop", messages: [assistant({ type: "text", text: "findings" })] });
    expect(streamErrorSuffix(clean)).toBe("");
    const failed = result({ stopReason: "error", errorMessage: "boom", messages: [] });
    expect(streamErrorSuffix(failed)).toBe("");
    const aborted = result({
      stopReason: "aborted",
      errorMessage: "aborted",
      messages: [assistant({ type: "text", text: "findings" })],
    });
    expect(streamErrorSuffix(aborted)).toBe("");
  });

  test("an error without the provider's words still warns", () => {
    const r = result({ stopReason: "error", messages: [assistant({ type: "text", text: "findings" })] });
    expect(streamErrorSuffix(r)).toContain("the provider reported an error");
  });
});

describe("mergeAttemptMessages", () => {
  const answered = assistant({ type: "text", text: "findings" });
  const emptyError = assistant({ type: "thinking", thinking: "plan" });

  test("a later attempt that produced an answer wins", () => {
    expect(mergeAttemptMessages([emptyError], [answered])).toEqual([answered]);
  });

  test("a retry that produced no answer does not wipe the earlier answer", () => {
    expect(mergeAttemptMessages([answered], [emptyError])).toEqual([answered]);
    expect(mergeAttemptMessages([answered], [])).toEqual([answered]);
  });

  test("an answer followed by a tool result still counts as the earlier answer", () => {
    // The handler records the retrying run's tool results as they arrive, so the
    // answer is not the last element of the batch it must be compared against.
    expect(mergeAttemptMessages([answered, toolResult], [emptyError])).toEqual([answered, toolResult]);
  });

  test("with no answer either side, the latest batch carries the newer error", () => {
    const newer = assistant({ type: "thinking", thinking: "still nothing" });
    expect(mergeAttemptMessages([emptyError], [newer])).toEqual([newer]);
  });
});

describe("chainStreamWarning", () => {
  test("is empty when every step completed", () => {
    const steps = [
      result({ stopReason: "stop", messages: [assistant({ type: "text", text: "one" })] }),
      result({ stopReason: "stop", messages: [assistant({ type: "text", text: "two" })] }),
    ];
    expect(chainStreamWarning(steps)).toBe("");
  });

  test("names each cut handoff by its step number", () => {
    const steps = [
      result({ stopReason: "stop", messages: [assistant({ type: "text", text: "one" })] }),
      result({
        stopReason: "error",
        errorMessage: "Network connection lost.",
        messages: [assistant({ type: "text", text: "two" })],
      }),
      result({ stopReason: "stop", messages: [assistant({ type: "text", text: "three" })] }),
      result({ stopReason: "error", errorMessage: "gone", messages: [] }),
    ];
    const warning = chainStreamWarning(steps);
    expect(warning).toContain("[step 2 (reviewer) stream ended early: Network connection lost.]");
    // A step with no answer is a failed run, which the chain stops on — not a cut handoff.
    expect(warning).not.toContain("step 4");
    expect(warning.split("\n")).toHaveLength(1);
  });
});

describe("withStreamWarning / withChainWarnings", () => {
  const cut = result({
    stopReason: "error",
    errorMessage: "Network connection lost.",
    messages: [assistant({ type: "text", text: "two" })],
  });
  const clean = result({ stopReason: "stop", messages: [assistant({ type: "text", text: "one" })] });

  test("a clean result's text is left alone", () => {
    expect(withStreamWarning("answer", clean)).toBe("answer");
    expect(withChainWarnings("answer", [clean])).toBe("answer");
  });

  test("a cut answer carries the warning under it", () => {
    expect(withStreamWarning("answer", cut)).toContain("answer\n\n[stream ended early: Network connection lost.");
  });

  test("a halted chain names an earlier cut step under the stop line", () => {
    const stopped = result({ stopReason: "error", errorMessage: "boom", messages: [] });
    const text = withChainWarnings("Chain stopped at step 2 (reviewer): boom", [cut, stopped]);
    expect(text).toContain("Chain stopped at step 2 (reviewer): boom");
    expect(text).toContain("[step 1 (reviewer) stream ended early: Network connection lost.]");
    // The failing step's own error is the stop line, not a second warning.
    expect(text).not.toContain("step 2 (reviewer) stream ended early");
  });
});

describe("childRetryPending", () => {
  test("only an explicit true defers finalization", () => {
    expect(childRetryPending({ willRetry: true })).toBe(true);
    expect(childRetryPending({ willRetry: false })).toBe(false);
    // A child that does not report the field is finished, not retrying.
    expect(childRetryPending({})).toBe(false);
    // Truthiness would defer on a string; the RPC field is a boolean or absent.
    expect(childRetryPending({ willRetry: "true" })).toBe(false);
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
