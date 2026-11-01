import { describe, expect, test } from "bun:test";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { JOB_SHORTCUTS } from "./shortcuts";

/**
 * The keys pi's own navigation owns: the select list's movement and cancel, and the fullscreen
 * renderer's page and search keys, which are handled before a focused component sees them.
 */
function navigationKeys(): Set<string> {
  const bound = new Set<string>();
  const entries = Object.entries(TUI_KEYBINDINGS) as Array<[string, { defaultKeys?: string | string[] }]>;
  for (const [name, definition] of entries) {
    if (!name.startsWith("tui.select.") && !name.startsWith("tui.altScreen.")) continue;
    const keys = definition.defaultKeys;
    for (const key of Array.isArray(keys) ? keys : keys ? [keys] : []) bound.add(key);
  }
  return bound;
}

describe("JOB_SHORTCUTS", () => {
  test("are ctrl chords, never bare letters", () => {
    for (const chord of Object.values(JOB_SHORTCUTS)) {
      expect(chord.startsWith("ctrl+")).toBe(true);
    }
  });

  test("take no key pi's navigation uses", () => {
    const bound = navigationKeys();
    // A filter that collects nothing would pass silently.
    expect(bound.has("ctrl+c")).toBe(true);
    expect(bound.has("pageUp")).toBe(true);
    for (const chord of Object.values(JOB_SHORTCUTS)) {
      expect({ chord, bound: bound.has(chord) }).toEqual({ chord, bound: false });
    }
  });
});
