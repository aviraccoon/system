/**
 * TUI rendering for subagent tool calls and results.
 *
 * Turn-aware display: assistant messages are grouped into turns. Collapsed
 * shows the last few turns (commands in full, no intermediate text); expanded
 * shows every turn with thinking styled separately from output.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createDebugLogger } from "../shared/debug";
import { resolveMode } from "./mode";
import {
  type DisplayItem,
  type DisplayTurn,
  formatToolCall,
  formatUsageStats,
  getDisplayTurns,
  getFinalOutput,
  type SingleResult,
  type SubagentDetails,
  type UsageStats,
  type UserInput,
} from "./rpc";

const COLLAPSED_TURNS = 3;
const COLLAPSED_OUTPUT_LINES = 4;
const COLLAPSED_THINKING_CHARS = 120;
const COLLAPSED_TEXT_LINES = 5;
const DEBUG_INTERVAL = 500;
const debugLog = createDebugLogger("subagent", "renderResult.log");

export function renderCall(args: Record<string, unknown>, theme: Theme, context: { expanded?: boolean } | unknown) {
  const scope: string = (args.agentScope as string) ?? "user";
  const showFull = Boolean((context as { expanded?: boolean } | undefined)?.expanded);
  if (args.chain && (args.chain as Array<unknown>).length > 0) {
    const chain = args.chain as Array<{ agent: string; task: string }>;
    let text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      theme.fg("accent", `chain (${chain.length} steps)`) +
      theme.fg("muted", ` [${scope}]`);
    for (let i = 0; i < Math.min(chain.length, showFull ? chain.length : 3); i++) {
      const step = chain[i];
      const cleanTask = (step.task as string).replace(/\{previous\}/g, "").trim();
      const preview = showFull ? cleanTask : cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (!showFull && chain.length > 3) text += `\n  ${theme.fg("muted", `... +${chain.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }
  const resolved = resolveMode(args);
  if (resolved.parallelTasks && resolved.parallelTasks.length > 0) {
    const tasks = resolved.parallelTasks;
    let text =
      theme.fg("toolTitle", theme.bold("subagent ")) +
      theme.fg("accent", `parallel (${tasks.length} tasks)`) +
      theme.fg("muted", ` [${scope}]`);
    for (const t of tasks.slice(0, showFull ? tasks.length : 3)) {
      const preview = showFull
        ? (t.task as string)
        : (t.task as string).length > 40
          ? `${(t.task as string).slice(0, 40)}...`
          : (t.task as string);
      text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
    }
    if (!showFull && tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
    return new Text(text, 0, 0);
  }
  const agentName = resolved.singleAgent ?? "...";
  const taskStr = resolved.singleTask ?? "";
  const preview = showFull ? taskStr : taskStr.length > 60 ? `${taskStr.slice(0, 60)}...` : taskStr;
  let text =
    theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", agentName) + theme.fg("muted", ` [${scope}]`);
  text += `\n  ${theme.fg("dim", preview)}`;
  return new Text(text, 0, 0);
}

// ── helpers ──

function isErrorResult(r: SingleResult): boolean {
  return (
    r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted" || r.stopReason === "max_turns_exceeded"
  );
}

function styleThinking(theme: Theme, text: string): string {
  return theme.italic(theme.fg("thinkingText", text));
}

function renderUserInput(input: UserInput, theme: Theme): string {
  return `${theme.fg("userMessageText", theme.bold("steering: "))}${theme.fg("dim", input.text)}`;
}

/** Collapse a thinking block to its last line (live tail) when not expanded. */
function capThinking(raw: string, expanded: boolean): string {
  if (expanded) return raw;
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const last = lines[lines.length - 1] ?? "";
  const capped = last.length > COLLAPSED_THINKING_CHARS ? `${last.slice(0, COLLAPSED_THINKING_CHARS)}…` : last;
  return lines.length > 1 ? `… ${capped}` : capped;
}

/** Collapse a text block to its last few lines (live tail) when not expanded. */
function capText(raw: string, expanded: boolean): string {
  if (expanded) return raw;
  const lines = raw.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const skipped = lines.length - COLLAPSED_TEXT_LINES;
  if (skipped <= 0) return lines.join("\n");
  return `… ${skipped} more line${skipped > 1 ? "s" : ""}\n${lines.slice(-COLLAPSED_TEXT_LINES).join("\n")}`;
}

/** All tool calls in a turn, rendered as `→ tool …` lines (commands in full). */
function renderToolCalls(items: DisplayItem[], theme: Theme): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.type === "toolCall") {
      lines.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
    }
  }
  return lines.join("\n");
}

/** Every item of a turn: thinking (italic, thinkingText), text (toolOutput), tool calls. */
function renderTurnBody(items: DisplayItem[], theme: Theme): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === "thinking") parts.push(styleThinking(theme, item.text));
    else if (item.type === "text") parts.push(theme.fg("toolOutput", item.text));
    else parts.push(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)));
  }
  return parts.join("\n");
}

/** Tool calls from the last `limit` turns, in full, with user inputs interleaved at their turn boundaries. */
function renderRecentTurns(
  turns: DisplayTurn[],
  userInputs: UserInput[],
  theme: Theme,
  limit: number,
): { text: string; skipped: number } {
  const shown = turns.slice(-limit);
  const skipped = turns.length - shown.length;
  const firstShownTurn = shown[0]?.turn ?? Number.MAX_SAFE_INTEGER;
  const lines: string[] = [];
  let ui = 0;
  // Skip steering inputs that arrived before the shown window (their turn is skipped).
  while (ui < userInputs.length && userInputs[ui].turn + 1 < firstShownTurn) ui++;
  for (const turn of shown) {
    while (ui < userInputs.length && userInputs[ui].turn + 1 <= turn.turn) {
      lines.push(renderUserInput(userInputs[ui], theme));
      ui++;
    }
    const calls = renderToolCalls(turn.items, theme);
    if (calls) lines.push(calls);
  }
  // Flush steers that arrived after the last shown turn.
  while (ui < userInputs.length) {
    lines.push(renderUserInput(userInputs[ui], theme));
    ui++;
  }
  return { text: lines.join("\n"), skipped };
}

/** Final output, truncated to COLLAPSED_OUTPUT_LINES when collapsed. */
function renderFinalOutput(finalOutput: string, theme: Theme, expanded: boolean): string {
  if (expanded) return theme.fg("toolOutput", finalOutput);
  const lines = finalOutput.split("\n");
  if (lines.length <= COLLAPSED_OUTPUT_LINES) return theme.fg("toolOutput", finalOutput);
  return `${theme.fg("toolOutput", lines.slice(0, COLLAPSED_OUTPUT_LINES).join("\n"))}\n${theme.fg("muted", "…")}`;
}

function usageLine(r: SingleResult, theme: Theme): string {
  const usageStr = formatUsageStats(r.usage, r.model);
  return usageStr ? theme.fg("dim", usageStr) : "";
}

function statusHeader(r: SingleResult, theme: Theme): string {
  const isError = isErrorResult(r);
  const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
  if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
  return text;
}

/** True when collapsed hides something expanded would reveal (earlier turns, longer output, thinking, intermediate text). */
function hasHiddenContent(r: SingleResult): boolean {
  const turns = getDisplayTurns(r.messages);
  const finalOutput = getFinalOutput(r.messages);
  return (
    turns.length > COLLAPSED_TURNS ||
    Boolean(finalOutput && finalOutput.split("\n").length > COLLAPSED_OUTPUT_LINES) ||
    turns.some((t) => t.items.some((i) => i.type === "thinking")) ||
    turns.slice(0, -1).some((t) => t.items.some((i) => i.type === "text"))
  );
}

function renderTurnsBody(turns: DisplayTurn[], userInputs: UserInput[], theme: Theme): string {
  const body: string[] = [];
  let ui = 0;
  for (const turn of turns) {
    while (ui < userInputs.length && userInputs[ui].turn + 1 <= turn.turn) {
      body.push(renderUserInput(userInputs[ui], theme));
      ui++;
    }
    if (turns.length > 1) body.push(theme.fg("muted", `─── Turn ${turn.turn} ───`));
    const turnBody = renderTurnBody(turn.items, theme);
    if (turnBody) body.push(turnBody);
  }
  while (ui < userInputs.length) {
    body.push(renderUserInput(userInputs[ui], theme));
    ui++;
  }
  return body.join("\n");
}

// ── single mode ──

function renderSingle(r: SingleResult, expanded: boolean, theme: Theme): string {
  const turns = getDisplayTurns(r.messages);
  const finalOutput = getFinalOutput(r.messages);
  const parts: string[] = [statusHeader(r, theme)];

  if (expanded) {
    parts.push(theme.fg("muted", "─── Task ───"), theme.fg("dim", r.task));
    const body = renderTurnsBody(turns, r.userInputs ?? [], theme) || theme.fg("muted", "(no output)");
    parts.push(body);
    if (isErrorResult(r) && r.errorMessage) parts.push(theme.fg("error", `Error: ${r.errorMessage}`));
  } else {
    if (isErrorResult(r) && r.errorMessage) {
      parts.push(theme.fg("error", `Error: ${r.errorMessage}`));
    } else {
      const { text, skipped } = renderRecentTurns(turns, r.userInputs ?? [], theme, COLLAPSED_TURNS);
      if (skipped > 0) parts.push(theme.fg("muted", `… ${skipped} earlier turn${skipped > 1 ? "s" : ""}`));
      if (text) parts.push(text);
      if (finalOutput) {
        parts.push(renderFinalOutput(finalOutput, theme, false));
      } else if (turns.length === 0) {
        parts.push(theme.fg("muted", "(no output)"));
      } else if (!text) {
        // Turns exist but nothing rendered (e.g. thinking-only run) — say so and hint.
        const hasThinking = turns.some((t) => t.items.some((i) => i.type === "thinking"));
        parts.push(theme.fg("muted", hasThinking ? "(thinking only)" : "(no output)"));
      }
    }
  }

  const usage = usageLine(r, theme);
  if (usage) parts.push(usage);
  // Hint whenever expanded would reveal something collapsed hides: earlier turns,
  // longer final output, any thinking, or intermediate text.
  if (!expanded && hasHiddenContent(r)) parts.push(theme.fg("muted", "(Ctrl+O to expand)"));
  return parts.join("\n");
}

// ── chain / parallel (shared per-result rendering) ──

function renderResultSummary(
  r: SingleResult,
  theme: Theme,
  opts: { expanded: boolean; running?: boolean; showFinalOutput: boolean },
): string {
  const turns = getDisplayTurns(r.messages);
  const finalOutput = getFinalOutput(r.messages);
  const lines: string[] = [];

  if (opts.expanded) {
    const body = renderTurnsBody(turns, r.userInputs ?? [], theme);
    if (body) lines.push(body);
    if (!body) lines.push(theme.fg("muted", opts.running ? "(running...)" : "(no output)"));
  } else {
    const { text, skipped } = renderRecentTurns(turns, r.userInputs ?? [], theme, COLLAPSED_TURNS);
    if (skipped > 0) lines.push(theme.fg("muted", `… ${skipped} earlier turn${skipped > 1 ? "s" : ""}`));
    if (text) lines.push(text);
    // Final output preview: always for single/chain-deliverable results, otherwise
    // only for text-only agents (no commands to show).
    const showPreview = Boolean(finalOutput && (opts.showFinalOutput || !text));
    if (showPreview) lines.push(renderFinalOutput(finalOutput, theme, false));
    if (!text && !showPreview) lines.push(theme.fg("muted", opts.running ? "(running...)" : "(no output)"));
  }

  const usage = formatUsageStats(r.usage, r.model);
  if (usage) lines.push(theme.fg("dim", usage));
  return lines.join("\n");
}

function aggregateUsage(results: SingleResult[]): UsageStats {
  const total: UsageStats = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.contextTokens += r.usage.contextTokens;
    total.turns += r.usage.turns;
  }
  return total;
}

// ── chain mode ──

function renderChain(details: SubagentDetails, expanded: boolean, theme: Theme): string {
  const results = details.results;
  const successCount = results.filter((r) => r.exitCode === 0).length;
  const icon = successCount === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const parts: string[] = [
    `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${results.length} steps`)}`,
  ];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const lines: string[] = [`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`];
    if (expanded) lines.push(theme.fg("dim", `Task: ${r.task}`));
    // Chain deliverable is the last step's output — show its preview when collapsed.
    lines.push(renderResultSummary(r, theme, { expanded, showFinalOutput: !expanded && i === results.length - 1 }));
    parts.push(lines.join("\n"));
  }

  const usageStr = formatUsageStats(aggregateUsage(results));
  if (usageStr) parts.push(`\n${theme.fg("dim", `Total: ${usageStr}`)}`);
  if (!expanded && results.some(hasHiddenContent)) parts.push(theme.fg("muted", "(Ctrl+O to expand)"));
  return parts.join("\n\n");
}

// ── parallel mode ──

function renderParallel(details: SubagentDetails, expanded: boolean, theme: Theme): string {
  const results = details.results;
  const running = results.filter((r) => r.exitCode === -1).length;
  const successCount = results.filter((r) => r.exitCode === 0).length;
  const failCount = results.filter((r) => r.exitCode > 0).length;
  const isRunning = running > 0;
  const icon = isRunning
    ? theme.fg("warning", "⏳")
    : failCount > 0
      ? theme.fg("warning", "◐")
      : theme.fg("success", "✓");
  const status = isRunning
    ? `${successCount + failCount}/${results.length} done, ${running} running`
    : `${successCount}/${results.length} tasks`;
  const parts: string[] = [`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`];

  for (const r of results) {
    const rIcon =
      r.exitCode === -1
        ? theme.fg("warning", "⏳")
        : r.exitCode === 0
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
    const lines: string[] = [`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`];
    if (expanded) lines.push(theme.fg("dim", `Task: ${r.task}`));
    lines.push(renderResultSummary(r, theme, { expanded, running: isRunning, showFinalOutput: false }));
    parts.push(lines.join("\n"));
  }

  if (!isRunning) {
    const usageStr = formatUsageStats(aggregateUsage(results));
    if (usageStr) parts.push(`\n${theme.fg("dim", `Total: ${usageStr}`)}`);
  }
  if (!expanded && results.some(hasHiddenContent)) parts.push(theme.fg("muted", "(Ctrl+O to expand)"));
  return parts.join("\n\n");
}

// ── entry ──

/** Append the child transcript paths, so a caller can read what a run actually did. */
export function withSessionPaths(text: string, files: Array<string | undefined>): string {
  const paths = files.filter((file): file is string => Boolean(file));
  if (paths.length === 0) return text;
  const label = paths.length === 1 ? "subagent session" : "subagent sessions";
  return `${text}\n\n[${label}: ${paths.join(", ")}]`;
}

export function renderResult(
  result: {
    content: Array<{ type: string; text?: string; name?: string; args?: Record<string, unknown> }>;
    details?: unknown;
  },
  { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  _context: unknown,
) {
  const details = result.details as SubagentDetails | undefined;
  if (!details || details.results.length === 0) {
    // Partial result during streaming — the live feed. Blocks are grouped by
    // type so deltas glue within a block but transitions (thinking→text, text→
    // toolCall) get a newline. Collapsed caps long blocks (thinking to one
    // line, text to the last few lines); expanded shows everything.
    const content = result.content as Array<{
      type: string;
      text?: string;
      name?: string;
      args?: Record<string, unknown>;
    }>;
    const blocks: string[] = [];
    let currentType = "";
    let currentRaw = "";
    const flush = () => {
      if (!currentRaw) {
        currentType = "";
        return;
      }
      const raw = currentRaw;
      currentRaw = "";
      const type = currentType;
      currentType = "";
      if (type === "thinking") {
        blocks.push(styleThinking(theme, capThinking(raw, expanded)));
      } else {
        blocks.push(theme.fg("toolOutput", capText(raw, expanded)));
      }
    };
    for (const item of content) {
      if (item.type === "toolCall") {
        flush();
        const tc = item as { type: "toolCall"; name: string; args: Record<string, unknown> };
        blocks.push(theme.fg("muted", "→ ") + formatToolCall(tc.name, tc.args, theme.fg.bind(theme)));
      } else if (item.type === "user") {
        flush();
        blocks.push(renderUserInput({ text: item.text || "", turn: 0 }, theme));
      } else {
        if (currentType !== item.type) flush();
        currentType = item.type === "thinking" ? "thinking" : "text";
        currentRaw += item.text || "";
      }
    }
    flush();
    const text = blocks.join("\n") || "(running...)";
    const allContentTypes = content.map((c) => c.type);
    debugLog("partial", DEBUG_INTERVAL, {
      isPartial,
      expanded,
      content0Type: content[0]?.type,
      contentTypes: allContentTypes,
      contentCount: allContentTypes.length,
      textLen: text.length,
      textPreview: `${text.slice(0, 200)}...[${text.length > 400 ? text.slice(-200) : "(end)"}]`,
    });
    return new Text(text, 0, 0);
  }

  if (details.mode === "single" && details.results.length === 1) {
    return new Text(renderSingle(details.results[0], expanded, theme), 0, 0);
  }

  if (details.mode === "chain") {
    return new Text(renderChain(details, expanded, theme), 0, 0);
  }

  if (details.mode === "parallel") {
    return new Text(renderParallel(details, expanded, theme), 0, 0);
  }

  const text = result.content[0];
  return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}
