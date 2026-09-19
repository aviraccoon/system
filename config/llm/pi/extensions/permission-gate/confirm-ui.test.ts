import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { type ConfirmResult, createConfirmUI, type TirithBanner } from "./confirm-ui";

// The dialog only calls requestRender() on the TUI, and fg() is the only theme
// method it uses. Everything else (SelectList, Editor, ScrollableText) works
// unrendered — the tests drive input and read the `done` result.
const fakeTui = { requestRender: () => {} } as unknown as TUI;
const fakeKb = {} as unknown as KeybindingsManager;

/** Mount the dialog; `last()` is the result passed to `done` after input,
 *  `fgCalls` records every theme.fg() the dialog performed. */
function mount(tirith: TirithBanner | undefined) {
  const results: ConfirmResult[] = [];
  const fgCalls: Array<{ color: string; text: string }> = [];
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
    (result) => results.push(result),
    "bash",
    ["Allow once", "Block"],
    undefined,
    undefined,
    undefined,
    undefined,
    tirith,
  );
  return { component, last: () => results[results.length - 1], fgCalls };
}

describe("createConfirmUI tirith cursor", () => {
  it("defaults to Block for a block banner", () => {
    const d = mount({ action: "block", summary: "[HIGH] curl_pipe_shell: Pipe to interpreter" });
    d.component.handleInput?.("\r");
    expect(d.last()?.choice).toBe("Block");
  });

  it("defaults to Allow for a warn whose findings keep HIGH severity", () => {
    // The coverage-gap regression: the mapped action is warn, the text is HIGH.
    const d = mount({ action: "warn", summary: "[HIGH] analysis_incomplete: body could not be resolved" });
    d.component.handleInput?.("\r");
    expect(d.last()?.choice).toBe("Allow once");
  });

  it("defaults to Allow with no tirith banner", () => {
    const d = mount(undefined);
    d.component.handleInput?.("\r");
    expect(d.last()?.choice).toBe("Allow once");
  });

  it("colours the banner by the mapped action", () => {
    const bannerColor = (d: ReturnType<typeof mount>) => d.fgCalls.find((c) => c.text.startsWith("tirith "))?.color;
    expect(bannerColor(mount({ action: "block", summary: "[HIGH] curl_pipe_shell: Pipe to interpreter" }))).toBe(
      "error",
    );
    expect(
      bannerColor(mount({ action: "warn", summary: "[HIGH] analysis_incomplete: body could not be resolved" })),
    ).toBe("warning");
  });
});
