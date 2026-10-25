import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { createConfirmUI, type TirithBanner } from "./confirm-ui";

// The dialog only calls requestRender() on the TUI, and fg() is the only theme
// method it uses. Everything else (SelectList, Editor, ScrollableText) works
// unrendered.
const fakeTui = { requestRender: () => {} } as unknown as TUI;
const fakeKb = {} as unknown as KeybindingsManager;

/** Mount the dialog; returns the component and every theme.fg() it performed. */
function mount(tirith: TirithBanner | undefined) {
  const fgCalls: Array<{ color: string; text: string }> = [];
  const results: Array<{ choice: string | null }> = [];
  const theme = {
    fg: (color: string, text: string) => {
      fgCalls.push({ color, text });
      return text;
    },
  } as unknown as Theme;
  const component = createConfirmUI(
    fakeTui,
    theme,
    fakeKb,
    (result) => results.push(result as { choice: string | null }),
    "bash",
    ["Allow once", "Block"],
    undefined,
    undefined,
    undefined,
    undefined,
    tirith,
  );
  return { component, fgCalls, last: () => results[results.length - 1] };
}

describe("createConfirmUI tirith banner", () => {
  it("colours the banner as a warning", () => {
    const { fgCalls } = mount({ summary: "[HIGH] mass_file_deletion: 3 paths removed" });
    expect(fgCalls.find((c) => c.text.startsWith("tirith "))?.color).toBe("warning");
  });

  it("does not move the cursor", () => {
    // The banner reports; only the sidecar's DANGEROUS verdict may default to Block.
    const { component, last } = mount({ summary: "[CRITICAL] unicode_tags: Unicode Tag characters" });
    component.handleInput?.("\r");
    expect(last()?.choice).toBe("Allow once");
  });
});
