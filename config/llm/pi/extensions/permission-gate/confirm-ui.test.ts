import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { type ConfirmResult, createConfirmUI, type DiffBody, type TirithBanner } from "./confirm-ui";

// The dialog only calls requestRender() on the TUI, and fg() is the only theme
// method it uses. Everything else (SelectList, Editor, ScrollableText) works
// unrendered, except that Editor.render sizes its viewport from terminal.rows, and
// the diff test renders the component to see the view expand.
const fakeTui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
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

// Terminal bytes, not key ids: the dialog matches raw input, and a ctrl+shift chord
// only ever arrives as CSI-u or modifyOtherKeys (pi-tui rejects the legacy control
// byte for a shifted chord).
const CTRL_SHIFT_C = "\x1b[99;6u";
const CTRL_SHIFT_E = "\x1b[101;6u";

/** Mount with the explain hint on and an explanation that is ready to show. */
async function mountWithChords(diffBody?: DiffBody) {
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
    {
      promise: Promise.resolve({ verdict: "risky", short: "writes a file", detail: "long explanation" }),
      abort: () => {},
    },
    { autoClassify: true, hasExplainRole: true },
    diffBody,
  );
  // Let the explanation promise settle so the detail can be toggled.
  await Promise.resolve();
  return { component, fgCalls, last: () => results[results.length - 1] };
}

describe("createConfirmUI dialog chords", () => {
  it("toggles auto-classify from the list", async () => {
    const { component, last } = await mountWithChords();
    component.handleInput?.(CTRL_SHIFT_C);
    component.handleInput?.("\r");
    expect(last()?.toggledAutoClassify).toBe(true);
  });

  it("toggles auto-classify while the note has focus", async () => {
    // The reason the chord carries Shift: it has to fire from the note field, where
    // Ctrl+A and Ctrl+E already mean line start and line end.
    const { component, last } = await mountWithChords();
    component.handleInput?.("\t");
    component.handleInput?.("do not run it");
    component.handleInput?.(CTRL_SHIFT_C);
    component.handleInput?.("\r");
    expect(last()).toMatchObject({ toggledAutoClassify: true, note: "do not run it" });
  });

  it("leaves Ctrl+A to the note editor", async () => {
    // Ctrl+A moves the editor cursor, so the next character lands at the line start.
    const { component, last } = await mountWithChords();
    component.handleInput?.("\t");
    component.handleInput?.("abc");
    component.handleInput?.("\x01");
    component.handleInput?.("x");
    component.handleInput?.("\r");
    expect(last()).toMatchObject({ note: "xabc" });
    expect(last()?.toggledAutoClassify).toBeUndefined();
  });

  it("expands the diff with its chord", async () => {
    // Ten changed lines: six in the compact view, all ten expanded, so the rendered
    // height is what changes when the view toggles.
    const lines = Array.from({ length: 10 }, (_, i) => `+ line ${i}`);
    const { component, fgCalls } = await mountWithChords({ lines, rawDiff: lines.join("\n") });
    expect(fgCalls.some((c) => c.text.includes("Ctrl+O full diff"))).toBe(true);
    const compact = component.render(80).length;
    component.handleInput?.("\x0f");
    expect(fgCalls.some((c) => c.text.includes("Ctrl+O compact diff"))).toBe(true);
    expect(component.render(80).length).toBeGreaterThan(compact);
  });

  it("names the chords it matches", async () => {
    // A hint is the only place a user learns the key, so it has to name the chord the
    // handler matches rather than merely mentioning that one exists.
    const { fgCalls } = await mountWithChords();
    const text = fgCalls.map((c) => c.text).join("\n");
    expect(text).toContain("Ctrl+Shift+C auto:on");
    expect(text).toContain("  [Ctrl+Shift+E]");
  });

  it("shows the detail chord in both directions", async () => {
    const { component, fgCalls } = await mountWithChords();
    const help = () => fgCalls.map((c) => c.text).filter((t) => t.includes("Ctrl+Shift+E"));
    expect(help().some((t) => t.includes("detail"))).toBe(true);
    component.handleInput?.(CTRL_SHIFT_E);
    expect(help().some((t) => t.includes("collapse"))).toBe(true);
  });

  it("toggles the explanation detail from the note, and leaves Ctrl+E alone", async () => {
    const { component, fgCalls } = await mountWithChords();
    expect(fgCalls.some((c) => c.text === "long explanation")).toBe(false);
    component.handleInput?.("\t");
    component.handleInput?.("\x05");
    expect(fgCalls.some((c) => c.text === "long explanation")).toBe(false);
    component.handleInput?.(CTRL_SHIFT_E);
    expect(fgCalls.some((c) => c.text === "long explanation")).toBe(true);
  });
});
