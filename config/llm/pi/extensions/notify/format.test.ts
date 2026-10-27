import { describe, expect, test } from "bun:test";
import {
  blockedNote,
  blockedPushBody,
  describeToolCall,
  durationLabel,
  lastAnswer,
  oneLine,
  settledNote,
  settledPushBody,
} from "./format";

describe("oneLine", () => {
  test("collapses whitespace and trims", () => {
    expect(oneLine("  a\n\n  b\tc  ", 40)).toBe("a b c");
  });

  test("bounds the length with an ellipsis", () => {
    expect(oneLine("abcdefghij", 5)).toBe("abcd…");
  });

  test("a string at the limit is untouched", () => {
    expect(oneLine("abcde", 5)).toBe("abcde");
  });
});

describe("describeToolCall", () => {
  test("a shell call shows its command", () => {
    expect(describeToolCall("bash", { command: "bun test --watch" })).toBe("bash bun test --watch");
  });

  test("a long command is bounded", () => {
    const label = describeToolCall("bash", { command: "x".repeat(200) });
    expect(label?.endsWith("…")).toBe(true);
    expect(label?.length).toBeLessThan(60);
  });

  test("a file tool shows the basename", () => {
    expect(describeToolCall("patch", { path: "/Users/acme/dev/acme/src/app.ts" })).toBe("patch app.ts");
  });

  test("a multi-file patch counts its targets without naming one", () => {
    expect(
      describeToolCall("patch", {
        path: "/Users/acme/dev/acme/src/app.ts",
        edits: [{ path: "/Users/acme/dev/acme/src/app.ts" }, { path: "/Users/acme/dev/acme/src/b.ts" }],
      }),
    ).toBe("patch 2 files");
  });

  test("the same file edited twice is one file", () => {
    expect(
      describeToolCall("patch", {
        path: "/Users/acme/dev/acme/src/app.ts",
        edits: [{ path: "/Users/acme/dev/acme/src/app.ts" }, { path: "/Users/acme/dev/acme/src/app.ts" }],
      }),
    ).toBe("patch app.ts");
  });

  test("a shell call without a command still names the tool", () => {
    expect(describeToolCall("bash", {})).toBe("bash");
  });

  test("an unrecognized call contributes nothing", () => {
    expect(describeToolCall("read", { offset: 10 })).toBeUndefined();
  });

  test("a malformed input is not a crash", () => {
    expect(describeToolCall("bash", null)).toBe("bash");
  });
});

describe("durationLabel", () => {
  const cases: Array<[number, string | undefined]> = [
    [59_000, undefined],
    [60_000, "1m"],
    [3_599_000, "59m"],
    [3_600_000, "1h"],
    [3_900_000, "1h5m"],
  ];

  for (const [ms, expected] of cases) {
    test(`${ms}ms`, () => {
      expect(durationLabel(ms)).toBe(expected);
    });
  }
});

const facts = { startedAt: 0, toolCalls: 3, lastAction: "bash bun test" };

describe("settledNote", () => {
  test("title carries the duration and the body carries the run", () => {
    const note = settledNote(
      { ...facts, lastToolError: "bash" },
      { project: "acme", session: "fix login", now: 240_000, snippet: "Done.\nTests pass." },
    );
    expect(note.title).toBe("pi done, 4m");
    expect(note.body).toBe('acme, 3 tools, bash bun test, FAILED bash, fix login, "Done. Tests pass."');
  });

  test("a short run has no duration in the title", () => {
    expect(settledNote(facts, { project: "acme", now: 10_000 }).title).toBe("pi done");
  });

  test("truncation is named", () => {
    expect(settledNote({ ...facts, truncated: true }, { project: "acme", now: 10_000 }).body).toContain("truncated");
  });
});

describe("settledPushBody", () => {
  test("carries counts and duration but never the command or the answer", () => {
    const context = { project: "acme", now: 240_000, snippet: "secret model output" };
    const body = settledPushBody({ ...facts, lastAction: "bash cat token.txt" }, context);
    expect(body).toBe("acme, 4m, 3 tools");
    expect(body).not.toContain("token.txt");
    expect(body).not.toContain("secret");
  });
});

describe("blockedNote", () => {
  test("a titled dialog is named", () => {
    expect(blockedNote({ kind: "confirm", title: "bash" }, { project: "acme" })).toEqual({
      title: "pi needs you",
      body: "acme, bash",
    });
  });

  test("a custom dialog has no title and is called one", () => {
    expect(blockedNote({ kind: "custom" }, { project: "acme" }).body).toBe("acme, dialog");
  });

  test("a titleless confirm falls back to its kind", () => {
    expect(blockedNote({ kind: "select" }, { project: "acme" }).body).toBe("acme, select");
  });
});

describe("blockedPushBody", () => {
  const cases: Array<[string, string]> = [
    ["confirm", "acme, a confirm is waiting"],
    ["select", "acme, a select is waiting"],
    ["input", "acme, an input is waiting"],
    ["editor", "acme, an editor is waiting"],
    ["custom", "acme, a dialog is waiting"],
  ];

  for (const [kind, expected] of cases) {
    test(kind, () => {
      expect(blockedPushBody({ project: "acme" }, kind)).toBe(expected);
    });
  }
});

describe("lastAnswer", () => {
  test("takes the last assistant text and joins its text blocks", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "final" },
          { type: "text", text: "words" },
        ],
      },
    ];
    expect(lastAnswer(messages)).toEqual({ snippet: "final words", truncated: false });
  });

  test("reports a length stop", () => {
    const messages = [{ role: "assistant", content: "cut off", stopReason: "length" }];
    expect(lastAnswer(messages)).toEqual({ snippet: "cut off", truncated: true });
  });

  test("no assistant message means nothing to report", () => {
    expect(lastAnswer([{ role: "user", content: "hi" }])).toEqual({});
  });

  test("an empty answer is not a snippet", () => {
    expect(lastAnswer([{ role: "assistant", content: [{ type: "text", text: "  " }] }])).toEqual({
      snippet: undefined,
      truncated: false,
    });
  });
});
