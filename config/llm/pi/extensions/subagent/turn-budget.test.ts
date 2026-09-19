import { describe, expect, it } from "bun:test";
import {
  NUDGE_TURNS_LEFT,
  nextNudge,
  nudgeAt,
  nudgeMessage,
  steerNudge,
  taskWithBudget,
  turnContinues,
} from "./turn-budget";

describe("nudgeAt", () => {
  it("fires with a few turns left", () => {
    expect(nudgeAt(30)).toBe(30 - NUDGE_TURNS_LEFT);
  });

  it("stays silent when the budget is too small to act on", () => {
    expect(nudgeAt(NUDGE_TURNS_LEFT)).toBeNull();
    expect(nudgeAt(NUDGE_TURNS_LEFT - 1)).toBeNull();
    expect(nudgeAt(1)).toBeNull();
  });
});

describe("nudgeMessage", () => {
  it("names the budget and tells the agent to stop calling tools", () => {
    const message = nudgeMessage(27, 30);
    expect(message).toContain("27/30");
    expect(message).toContain("3 left");
    expect(message).toContain("STOP INVESTIGATING");
    expect(message).toContain("Do not call any more tools");
    expect(message).toContain("what you could not verify");
  });
});

describe("turnContinues", () => {
  it("a turn with tool calls is still working", () => {
    expect(
      turnContinues({
        content: [
          { type: "text", text: "checking" },
          { type: "toolCall", name: "bash" },
        ],
      }),
    ).toBe(true);
  });

  it("a final answer ends the run", () => {
    expect(turnContinues({ content: [{ type: "text", text: "report" }] })).toBe(false);
  });

  it("an errored or aborted response is not a continuation", () => {
    const call = { type: "toolCall", name: "bash" };
    expect(turnContinues({ stopReason: "error", content: [call] })).toBe(false);
    expect(turnContinues({ stopReason: "aborted", content: [call] })).toBe(false);
  });

  it("malformed input does not nudge", () => {
    expect(turnContinues(undefined)).toBe(false);
    expect(turnContinues({})).toBe(false);
    expect(turnContinues({ content: "text" })).toBe(false);
  });
});

describe("nextNudge", () => {
  const at = 30 - NUDGE_TURNS_LEFT;
  const working = { content: [{ type: "toolCall", name: "bash" }] };
  const done = { content: [{ type: "text", text: "report" }] };

  it("fires at the nudge turn while the run is working, and latches", () => {
    expect(nextNudge(30, at, working, false)).toEqual({ send: true, nudgeSent: true });
  });

  it("stays silent on a final answer, and does not latch", () => {
    expect(nextNudge(30, at, done, false)).toEqual({ send: false, nudgeSent: false });
  });

  it("waits for a later working turn when the threshold turn was not one", () => {
    expect(nextNudge(30, at + 1, working, false)).toEqual({ send: true, nudgeSent: true });
  });

  it("fires at most once", () => {
    expect(nextNudge(30, at + 1, working, true)).toEqual({ send: false, nudgeSent: true });
  });

  it("stays silent when the budget is too small", () => {
    expect(nextNudge(NUDGE_TURNS_LEFT, NUDGE_TURNS_LEFT, working, false)).toEqual({
      send: false,
      nudgeSent: false,
    });
  });
});

describe("steerNudge", () => {
  const at = 30 - NUDGE_TURNS_LEFT;
  const working = { content: [{ type: "toolCall", name: "bash" }] };
  const done = { content: [{ type: "text", text: "report" }] };

  it("steers once when the threshold turn is working, and latches", () => {
    const state = { sent: false };
    const steered: string[] = [];
    steerNudge(state, 30, at, working, (text) => steered.push(text));
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain("STOP INVESTIGATING");
    expect(state.sent).toBe(true);
  });

  it("does not steer again on a later working turn", () => {
    const state = { sent: false };
    const steered: string[] = [];
    steerNudge(state, 30, at, working, (text) => steered.push(text));
    steerNudge(state, 30, at + 1, working, (text) => steered.push(text));
    expect(steered).toHaveLength(1);
  });

  it("leaves the latch unset on a final answer", () => {
    const state = { sent: false };
    const steered: string[] = [];
    steerNudge(state, 30, at, done, (text) => steered.push(text));
    expect(steered).toHaveLength(0);
    expect(state.sent).toBe(false);
  });
});

describe("taskWithBudget", () => {
  it("keeps the task and states the cap with its consequence", () => {
    const message = taskWithBudget("Review the diff.", 12);
    expect(message).toContain("Task: Review the diff.");
    expect(message).toContain("Turn budget: 12 turns");
    expect(message).toContain("aborted at turn 12");
  });
});
