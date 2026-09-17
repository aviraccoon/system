import { describe, expect, it } from "bun:test";
import { NUDGE_TURNS_LEFT, nudgeAt, nudgeMessage, taskWithBudget } from "./turn-budget";

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

describe("taskWithBudget", () => {
  it("keeps the task and states the cap with its consequence", () => {
    const message = taskWithBudget("Review the diff.", 12);
    expect(message).toContain("Task: Review the diff.");
    expect(message).toContain("Turn budget: 12 turns");
    expect(message).toContain("aborted at turn 12");
  });
});
