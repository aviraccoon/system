import { describe, expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { attemptOutcome, finalAnswerText, resultFailed, type SingleResult } from "./rpc";

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
