import { describe, expect, test } from "bun:test";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { gateNoteColor, gateNoteText, renderReviewResult } from "./render";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const collapsed = { expanded: false, isPartial: false } as ToolRenderResultOptions;
const expanded = { expanded: true, isPartial: false } as ToolRenderResultOptions;

function render(component: { render(width: number): string[] }): string {
  return component.render(80).join("\n");
}

describe("review tool rendering", () => {
  test("the gate note is the last text block, and only when a report precedes it", () => {
    expect(
      gateNoteText([
        { type: "text", text: "## Findings\n\nNone." },
        { type: "text", text: "gate: clean for tree abc" },
      ]),
    ).toBe("gate: clean for tree abc");
    expect(gateNoteText([{ type: "text", text: "a single block" }])).toBeNull();
    expect(gateNoteText([{ type: "image" }, { type: "text", text: "only text" }])).toBeNull();
    expect(gateNoteText([])).toBeNull();
  });

  test("the note color names the gate state", () => {
    expect(gateNoteColor("gate: clean for tree abc")).toBe("success");
    expect(gateNoteColor("gate: not a git repository — no commit gate applies")).toBe("warning");
    expect(gateNoteColor("gate: blocked for tree abc — severity 0.95")).toBe("warning");
    expect(gateNoteColor("gate: the reviewer did not complete a review run")).toBe("error");
  });

  test("a completed result without details renders in full, not as a running child", () => {
    const report = ["## Findings", ...Array.from({ length: 25 }, (_, index) => `line ${index + 2}`)].join("\n");
    const text = render(
      renderReviewResult(
        {
          content: [
            { type: "text", text: report },
            { type: "text", text: "gate: blocked for tree abc" },
          ],
          details: undefined,
        },
        collapsed,
        theme,
        {},
      ),
    );
    expect(text).toContain("## Findings");
    expect(text).toContain("gate: blocked for tree abc");
    expect(text).not.toContain("(running...)");
    // The delegated streaming branch would keep only the tail, dropping the head.
    expect(text).not.toContain("line 26");
  });

  test("a long report is capped when collapsed and complete when expanded", () => {
    const report = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    const result: AgentToolResult<unknown> = {
      content: [
        { type: "text", text: report },
        { type: "text", text: "gate: blocked for tree abc" },
      ],
      details: undefined,
    };
    const short = render(renderReviewResult(result, collapsed, theme, {}));
    expect(short).toContain("line 1");
    expect(short).toContain("20 more lines (Ctrl+O to expand)");
    expect(short).not.toContain("line 30");
    expect(short).toContain("gate: blocked for tree abc");
    const full = render(renderReviewResult(result, expanded, theme, {}));
    expect(full).toContain("line 30");
    expect(full).not.toContain("more line");
    const one = render(
      renderReviewResult(
        {
          content: [
            { type: "text", text: Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join("\n") },
            { type: "text", text: "gate: blocked for tree abc" },
          ],
          details: undefined,
        },
        collapsed,
        theme,
        {},
      ),
    );
    expect(one).toContain("1 more line (Ctrl+O to expand)");
  });

  test("a partial result goes to the subagent live feed and never appends the note", () => {
    const result: AgentToolResult<unknown> = {
      content: [
        { type: "text", text: "reading src/a.ts" },
        { type: "text", text: "gate: blocked for tree abc" },
      ],
      details: {
        mode: "single",
        results: [
          {
            agent: "reviewer",
            agentSource: "user",
            task: "review",
            exitCode: 0,
            stderr: "",
            messages: [{ role: "assistant", content: [{ type: "text", text: "reading src/a.ts" }] }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
          },
        ],
      },
    };
    const partial = render(
      renderReviewResult(result, { expanded: false, isPartial: true } as ToolRenderResultOptions, theme, {}),
    );
    expect(partial).toContain("reading src/a.ts");
    expect(partial).not.toContain("gate: blocked for tree abc");
  });
});
