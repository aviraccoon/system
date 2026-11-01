import { describe, expect, it } from "bun:test";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { GATE_SHORTCUTS } from "./shortcuts";

/** Every key pi-tui binds inside a focused text field: the set the gate's toggles must avoid. */
function editorKeys(): Set<string> {
  const bound = new Set<string>();
  const entries = Object.entries(TUI_KEYBINDINGS) as Array<[string, { defaultKeys?: string | string[] }]>;
  for (const [name, definition] of entries) {
    if (!name.startsWith("tui.editor.") && !name.startsWith("tui.input.")) continue;
    const keys = definition.defaultKeys;
    for (const key of Array.isArray(keys) ? keys : keys ? [keys] : []) bound.add(key);
  }
  return bound;
}

describe("GATE_SHORTCUTS", () => {
  it("takes no key the note editor binds", () => {
    // The rule the table exists for: a chord the focused component owns belongs to it,
    // which is why the note editor keeps Ctrl+A and Ctrl+E.
    const bound = editorKeys();
    expect(bound.has("ctrl+a")).toBe(true);
    for (const chord of Object.values(GATE_SHORTCUTS)) {
      expect({ chord, bound: bound.has(chord) }).toEqual({ chord, bound: false });
    }
  });
});
