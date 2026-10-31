import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { type ConfirmResult, createConfirmUI, type TirithBanner } from "./confirm-ui";

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

/** Mount the dialog on a deadline driven by a clock the test moves. */
function mountWithDeadline(timeoutSeconds: number) {
  let now = 1_000_000;
  const callbacks: Array<() => void> = [];
  const fgCalls: Array<{ color: string; text: string }> = [];
  const results: ConfirmResult[] = [];
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
    {
      timeoutSeconds,
      deadlineDeps: {
        now: () => now,
        repeat: (callback) => {
          callbacks.push(callback);
          return () => {};
        },
      },
    },
  );
  return {
    component,
    fgCalls,
    last: () => results[results.length - 1],
    results,
    tick(advanceMs = 1000) {
      now += advanceMs;
      for (const callback of callbacks) callback();
    },
  };
}

describe("createConfirmUI deadline", () => {
  it("denies an unanswered dialog and says it timed out", () => {
    const { tick, last } = mountWithDeadline(2);
    tick();
    expect(last()).toBeUndefined();
    tick();
    expect(last()).toMatchObject({ choice: null, timedOut: true });
  });

  it("keeps the dialog open when a keystroke arrives, so a reader never loses it", () => {
    const { component, tick, last } = mountWithDeadline(2);
    tick();
    component.handleInput?.("j");
    tick();
    expect(last()).toBeUndefined();
    tick();
    expect(last()).toMatchObject({ timedOut: true });
  });

  it("shows the countdown in the title only near expiry", () => {
    const { fgCalls, tick } = mountWithDeadline(40);
    tick();
    expect(fgCalls.some((c) => c.text.startsWith("bash (denies in"))).toBe(false);
    for (let i = 0; i < 11; i += 1) tick();
    expect(fgCalls.some((c) => c.text === "bash (denies in 29s)")).toBe(true);
  });

  it("arms no deadline when there is none to arm", () => {
    const { tick, last, fgCalls } = mountWithDeadline(0);
    tick(600_000);
    expect(last()).toBeUndefined();
    expect(fgCalls.some((c) => c.text.startsWith("bash (denies in"))).toBe(false);
  });

  it("stops the deadline when the dialog is disposed", () => {
    const { component, tick, last } = mountWithDeadline(1);
    component.dispose();
    tick();
    expect(last()).toBeUndefined();
  });

  it("does not report a timeout after the user answered", () => {
    const { component, tick, last } = mountWithDeadline(2);
    component.handleInput?.("\r");
    tick();
    tick();
    expect(last()).toMatchObject({ choice: "Allow once" });
    expect(last()?.timedOut).toBeUndefined();
  });

  it("drops an unsent note draft when it expires", () => {
    const { component, tick, last } = mountWithDeadline(1);
    component.handleInput?.("\t"); // focus the note editor
    component.handleInput?.("do not run it");
    tick();
    expect(last()).toMatchObject({ choice: null, timedOut: true, note: "" });
  });
});
