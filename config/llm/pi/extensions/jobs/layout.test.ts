import { describe, expect, test } from "bun:test";
import { dialogHeight, listBodyHeight, splitOutput, windowRows } from "./layout";

describe("dialogHeight", () => {
  test("takes about two thirds of a normal screen", () => {
    expect(dialogHeight(24)).toBe(16);
    expect(dialogHeight(40)).toBe(30);
  });

  test("never leaves less than three rows below it, whatever the terminal", () => {
    // The dock holds the footer, so a dialog that fills the screen hides it.
    for (const rows of [0, 1, 4, 6, 8, 10, 24, 40, 200]) {
      expect(dialogHeight(rows)).toBeLessThanOrEqual(Math.max(1, rows - 3));
    }
  });

  test("keeps a floor on a normal screen and yields to the hard ceiling on a tiny one", () => {
    expect(dialogHeight(12)).toBe(6);
    expect(dialogHeight(6)).toBe(3);
  });

  test("is capped, so a tall terminal does not produce a 60-row list", () => {
    expect(dialogHeight(200)).toBe(30);
  });
});

describe("listBodyHeight", () => {
  test("leaves room for the title, the blank and the two hint lines", () => {
    expect(listBodyHeight(16)).toBe(12);
  });

  test("never returns a body of zero", () => {
    expect(listBodyHeight(2)).toBe(1);
  });
});

describe("windowRows", () => {
  test("shows everything when it fits", () => {
    expect(windowRows(3, 1, 10)).toEqual({ start: 0, end: 3 });
    expect(windowRows(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  test("clamps at the top so the window stays full", () => {
    expect(windowRows(50, 0, 10)).toEqual({ start: 0, end: 10 });
  });

  test("centers the selection in the middle of a long list", () => {
    expect(windowRows(50, 25, 10)).toEqual({ start: 20, end: 30 });
  });

  test("clamps at the bottom", () => {
    expect(windowRows(50, 49, 10)).toEqual({ start: 40, end: 50 });
  });

  test("survives a selection outside the list, which a refresh can produce", () => {
    expect(windowRows(5, 99, 3)).toEqual({ start: 2, end: 5 });
    expect(windowRows(5, -7, 3)).toEqual({ start: 0, end: 3 });
  });
});

describe("splitOutput", () => {
  test("a one-line command costs one row", () => {
    const split = splitOutput(16, 1);
    expect(split.command).toBe(1);
    expect(split.log).toBe(12);
    // header + command + blank + log + hint
    expect(1 + split.command + 1 + split.log + 1).toBe(16);
  });

  test("a heredoc is capped at 40% of the body so the log keeps room", () => {
    const split = splitOutput(16, 40);
    expect(split.command).toBe(5);
    expect(split.log).toBe(8);
  });

  test("an empty command still gets one row", () => {
    expect(splitOutput(16, 0)).toEqual({ command: 1, log: 12 });
  });

  test("the smallest dialog still splits into two non-empty panes", () => {
    const split = splitOutput(3, 10);
    expect(split.command).toBe(1);
    expect(split.log).toBe(1);
  });
});
