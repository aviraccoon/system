import { describe, expect, it } from "bun:test";
import { NUDGE_TURNS_LEFT, nudgeAt, nudgeMessage } from "./turn-budget";

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
  it("names the budget and asks for the report", () => {
    const message = nudgeMessage(27, 30);
    expect(message).toContain("27/30");
    expect(message).toContain("3 left");
    expect(message).toContain("what you could not verify");
  });
});
