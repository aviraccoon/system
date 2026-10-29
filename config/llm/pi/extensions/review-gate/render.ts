/**
 * Rendering for the `review` tool.
 *
 * The tool wraps a reviewer run, so it reuses the subagent renderer: the
 * partial state shows the child's live feed (tool calls, thinking, text), which
 * is what a steer decision needs, and the final state shows its turn view. The
 * gate note is drawn below that, from the last content block. A result with no
 * child details must not go through the streaming branch — it would cap the
 * report to its tail and look like a run still in progress — so it draws the
 * report and its colored note itself, capped when collapsed, instead of the
 * streaming tail.
 */

import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderResult as renderSubagentResult } from "../subagent/render";

type TextBlock = { type: string; text?: string };

/** Collapsed, a long report keeps its head and says the rest can be expanded. */
const COLLAPSED_REPORT_LINES = 10;

function capReport(text: string, expanded: boolean): string {
  if (expanded) return text;
  const lines = text.split("\n");
  if (lines.length <= COLLAPSED_REPORT_LINES) return text;
  const kept = lines.slice(0, COLLAPSED_REPORT_LINES).join("\n");
  const more = lines.length - COLLAPSED_REPORT_LINES;
  return `${kept}\n… ${more} more line${more === 1 ? "" : "s"} (Ctrl+O to expand)`;
}

function textBlocks(content: TextBlock[]): string[] {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "");
}

/** The gate note is the last text block, and only when a report precedes it. */
export function gateNoteText(content: TextBlock[]): string | null {
  const texts = textBlocks(content);
  return texts.length >= 2 ? (texts[texts.length - 1] ?? null) : null;
}

export function gateNoteColor(note: string): "success" | "warning" | "error" {
  if (note.startsWith("gate: clean")) {
    // A clean round whose hooks cannot run is not a gated commit.
    return note.includes("the gate's hooks are not active") ? "warning" : "success";
  }
  if (note.startsWith("gate: not a git repository")) return "warning";
  if (note.startsWith("gate: nothing recorded")) return "warning";
  if (note.startsWith("gate: blocked")) return "warning";
  return "error";
}

function fullText(texts: string[], expanded: boolean, theme: Theme) {
  if (texts.length < 2) return new Text(capReport(texts.join("\n\n") || "(no output)", expanded), 1, 0);
  const container = new Container();
  container.addChild(new Text(capReport(texts.slice(0, -1).join("\n\n"), expanded), 1, 0));
  const note = texts[texts.length - 1] ?? "";
  container.addChild(new Text(theme.fg(gateNoteColor(note), note), 1, 0));
  return container;
}

export function renderReviewResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: unknown,
) {
  if (!options.isPartial && !result.details) {
    return fullText(textBlocks(result.content as TextBlock[]), options.expanded, theme);
  }
  const base = renderSubagentResult(result as Parameters<typeof renderSubagentResult>[0], options, theme, context);
  if (options.isPartial) return base;
  const note = gateNoteText(result.content as TextBlock[]);
  if (!note) return base;
  const container = new Container();
  container.addChild(base);
  container.addChild(new Text(theme.fg(gateNoteColor(note), note), 1, 0));
  return container;
}
