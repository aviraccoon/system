import { describe, expect, test } from "bun:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { ScrollableText } from "./scrollable-text";

function wheel(wheelDelta: number): TuiMouseEvent {
  return {
    type: "wheel",
    button: "none",
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  };
}

const theme = {
  scrollHint: (t: string) => `[hint:${t}]`,
  border: (t: string) => `[border:${t}]`,
};

describe("ScrollableText", () => {
  test("renders all lines when they fit", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const s = new ScrollableText(lines, 5, theme);
    const output = s.render(80);
    expect(output).toEqual(["line 1", "line 2", "line 3"]);
  });

  test("truncates and shows scroll hint when lines overflow", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g"];
    const s = new ScrollableText(lines, 4, theme);
    const output = s.render(80);
    // 3 visible lines + 1 hint line = 4
    expect(output.length).toBe(4);
    expect(output[0]).toBe("a");
    expect(output[2]).toBe("c");
    expect(output[3]).toContain("4 below");
  });

  test("scrolls down on down key", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const s = new ScrollableText(lines, 3, theme);

    // Initial: a, b visible + hint
    expect(s.render(80)[0]).toBe("a");

    // Scroll down
    const consumed = s.handleInput("\x1b[B"); // down arrow
    expect(consumed).toBe(true);
    const output = s.render(80);
    expect(output[0]).toBe("b");
  });

  test("does not consume input when not scrollable", () => {
    const lines = ["a", "b"];
    const s = new ScrollableText(lines, 5, theme);
    expect(s.scrollable).toBe(false);
    expect(s.handleInput("\x1b[B")).toBe(false);
  });

  test("scrollable property reflects overflow", () => {
    const lines = ["a", "b", "c"];
    const s = new ScrollableText(lines, 2, theme);
    expect(s.scrollable).toBe(true);
  });

  test("setLines resets scroll offset", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const s = new ScrollableText(lines, 3, theme);
    s.handleInput("\x1b[B"); // scroll down
    s.handleInput("\x1b[B");
    s.setLines(["x", "y", "z", "w"]);
    expect(s.render(80)[0]).toBe("x");
  });

  test("setMaxHeight changes viewport", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const s = new ScrollableText(lines, 3, theme);
    expect(s.render(80).length).toBe(3); // 2 lines + hint

    s.setMaxHeight(5);
    expect(s.render(80).length).toBe(5); // all lines fit
    expect(s.scrollable).toBe(false);
  });

  test("single letters are left to the host", () => {
    // A host embeds this under its own chords; `k` in particular means kill in /jobs.
    const s = new ScrollableText(["a", "b", "c", "d", "e"], 3, theme);
    s.render(80);
    expect(s.handleInput("k")).toBe(false);
    expect(s.handleInput("j")).toBe(false);
    expect(s.render(80)[0]).toBe("a");
  });

  test("scrollBy reports movement and clamps at both ends", () => {
    const s = new ScrollableText(["a", "b", "c", "d", "e"], 3, theme);
    s.render(80);
    expect(s.scrollBy(-1)).toBe(false); // already at the top
    expect(s.scrollBy(2)).toBe(true);
    expect(s.render(80)[0]).toBe("c");
    expect(s.scrollBy(99)).toBe(true);
    expect(s.render(80)[0]).toBe("d"); // 5 lines, 2-line viewport, offset 3
    expect(s.scrollBy(1)).toBe(false);
    expect(s.render(80)[0]).toBe("d");
  });

  test("never renders more rows than its max height, hint row included", () => {
    // A one-row budget is a real case: the output screen gives a single-line command exactly one row,
    // and a command wider than the pane wraps inside it.
    const long = [`$ ${"x".repeat(300)}`];
    expect(new ScrollableText(long, 1, theme).render(80).length).toBe(1);
    expect(new ScrollableText(long, 2, theme).render(80).length).toBe(2);
  });

  test("an unchanged max height keeps the wrap cache, a changed one drops it", () => {
    const s = new ScrollableText(["a", "b", "c", "d", "e"], 3, theme);
    const first = s.render(80);
    s.setMaxHeight(3);
    expect(s.render(80)).toBe(first);
    s.setMaxHeight(4);
    expect(s.render(80)).not.toBe(first);
  });

  test("scrollToEnd parks at the last page even before a render", () => {
    const s = new ScrollableText(["a", "b", "c", "d", "e"], 3, theme);
    s.scrollToEnd();
    expect(s.render(80)[0]).toBe("d");
  });

  test("setLines keeps the offset only when asked", () => {
    const s = new ScrollableText(["a", "b", "c", "d", "e"], 3, theme);
    s.scrollBy(2);
    expect(s.render(80)[0]).toBe("c");
    s.setLines(["v", "w", "x", "y", "z"], { keepOffset: true });
    expect(s.render(80)[0]).toBe("x");
    s.setLines(["v", "w", "x", "y", "z"]);
    expect(s.render(80)[0]).toBe("v");
  });

  test("the wheel scrolls one way for a positive delta and back for a negative one", () => {
    const s = new ScrollableText(["a", "b", "c", "d", "e"], 3, theme);
    s.render(80);
    // pi-tui's convention: negative is upward, so a positive delta moves down the content.
    expect(s.handleMouse(wheel(1))).toEqual({ handled: true, render: true });
    expect(s.render(80)[0]).toBe("b");
    expect(s.handleMouse(wheel(-1))).toEqual({ handled: true, render: true });
    expect(s.render(80)[0]).toBe("a");
  });

  test("a wheel event is consumed even when the content cannot move, and says so", () => {
    // Falling through would scroll the transcript behind the pane; `render: false` lets a host tell
    // a real scroll from a no-op, which is what stops a follow pane from detaching on a dead wheel.
    const s = new ScrollableText(["a"], 3, theme);
    s.render(80);
    expect(s.handleMouse(wheel(-3))).toEqual({ handled: true, render: false });
    expect(s.render(80)[0]).toBe("a");
  });

  test("non-wheel mouse events are left to the host", () => {
    const s = new ScrollableText(["a"], 3, theme);
    expect(s.handleMouse({ ...wheel(0), type: "click", button: "left" })).toBeUndefined();
  });
});
