import { describe, expect, test } from "bun:test";
import { shortcutLabel } from "./shortcuts";

describe("shortcutLabel", () => {
  test("capitalizes every part of a chord", () => {
    expect(shortcutLabel("ctrl+shift+c")).toBe("Ctrl+Shift+C");
  });

  test("capitalizes a chord and a modifier-less key", () => {
    expect(shortcutLabel("ctrl+o")).toBe("Ctrl+O");
    expect(shortcutLabel("tab")).toBe("Tab");
    expect(shortcutLabel("pageUp")).toBe("PageUp");
  });

  test("keeps a modifier chain in the order it was written", () => {
    expect(shortcutLabel("ctrl+alt+]")).toBe("Ctrl+Alt+]");
  });
});
