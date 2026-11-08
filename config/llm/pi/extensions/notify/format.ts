/**
 * Notification content. Two audiences with different exposure:
 *
 * - The terminal frame is local, so it can carry the last command and a snippet
 *   of the answer.
 * - The push leaves the machine (ntfy.sh by default: anyone holding the topic
 *   can read it), so it carries the project, counts, durations, two outcome
 *   flags, how much background work is still running by kind and the blocked
 *   dialog's kind: the last tool failed, the answer was truncated, a confirm or a
 *   picker is waiting. Never a command, never model output, and never a dialog
 *   title: titles are authored by other extensions and can quote a diff.
 */

import { basename } from "node:path";
import { collectToolPaths } from "../shared/edit-tools";

export interface Note {
  title: string;
  body: string;
}

/** The part of an announced unit of work a notification reads: not what it is doing. */
export interface PendingKind {
  kind: string;
}

/**
 * "1 job", "2 subagents": work still running when the agent stopped calling tools.
 * The kinds are the owners' own words, pluralized here, so a producer that
 * announces work carries no wording of its own. Sorted, so the same set always
 * reads the same way.
 */
export function pendingLabel(pending: readonly PendingKind[]): string | undefined {
  if (pending.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const item of pending) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${kind}${count === 1 ? "" : "s"}`);
  return `${parts.join(", ")} running`;
}

export interface RunFacts {
  startedAt: number;
  toolCalls: number;
  lastAction?: string;
  /** The last tool result was an error. A later success clears it: a failure the
   * agent already recovered from is not news. */
  lastToolError?: string;
  truncated?: boolean;
}

export interface SettledContext {
  project: string;
  session?: string;
  now: number;
  snippet?: string;
}

const MAX_FIELD = 60;
const MAX_SNIPPET = 120;

/** Collapse to one line and bound the length. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * A one-line label for a tool call: the command, the file's basename, or how many
 * files a multi-file patch touched.
 */
export function describeToolCall(toolName: string, input: unknown): string | undefined {
  const record = isRecord(input) ? input : {};
  const command = record.command;
  if (typeof command === "string" && command.trim()) return `${toolName} ${oneLine(command, 40)}`;
  const paths = collectToolPaths(toolName, record);
  if (paths.length === 1) return `${toolName} ${basename(paths[0])}`;
  if (paths.length > 1) return `${toolName} ${paths.length} files`;
  return toolName === "bash" ? "bash" : undefined;
}

export function durationLabel(ms: number): string | undefined {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return undefined;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
}

/** Terminal-frame note for a run that finished and will not continue. */
export function settledNote(facts: RunFacts, context: SettledContext, pending: readonly PendingKind[] = []): Note {
  const duration = durationLabel(context.now - facts.startedAt);
  const waiting = pendingLabel(pending);
  const title = ["pi done", waiting, duration].filter((part): part is string => part !== undefined).join(", ");
  const parts = [context.project];
  if (waiting) parts.push(waiting);
  if (facts.toolCalls > 0) parts.push(`${facts.toolCalls} tools`);
  if (facts.lastAction) parts.push(facts.lastAction);
  if (facts.lastToolError) parts.push(`FAILED ${facts.lastToolError}`);
  if (facts.truncated) parts.push("truncated");
  if (context.session) parts.push(context.session);
  if (context.snippet) parts.push(`"${oneLine(context.snippet, MAX_SNIPPET)}"`);
  return { title, body: parts.join(", ") };
}

/**
 * Push body for a settled run: project, counts and outcome flags. The last command
 * and the answer stay on the machine, and the duration belongs to the title, which
 * the push shares with the frame.
 */
export function settledPushBody(facts: RunFacts, context: { project: string }): string {
  const parts = [context.project];
  if (facts.toolCalls > 0) parts.push(`${facts.toolCalls} tools`);
  if (facts.lastToolError) parts.push(`FAILED ${facts.lastToolError}`);
  if (facts.truncated) parts.push("truncated");
  return parts.join(", ");
}

export interface AnswerFacts {
  snippet?: string;
  truncated?: boolean;
}

/** The subset of a transcript entry this module reads. */
interface AnswerMessage {
  role: string;
  content?: string | readonly { type: string; text?: string }[];
  stopReason?: string;
}

/** The last assistant text of a finished run, plus whether it hit the length limit. */
export function lastAnswer(messages: readonly AnswerMessage[]): AnswerFacts {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const content = message.content ?? "";
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join(" ");
    return {
      snippet: text.trim() ? text : undefined,
      truncated: message.stopReason === "length",
    };
  }
  return {};
}

export interface PromptInfo {
  kind: string;
  title?: string;
}

/** Terminal-frame note for a dialog that is blocking the agent. */
export function blockedNote(prompt: PromptInfo, context: { project: string }): Note {
  // pi reports the dialog title for select/confirm/input. `custom()` carries
  // none, and that is where the most frequent dialog comes from.
  const what = prompt.title ? oneLine(prompt.title, MAX_FIELD) : prompt.kind === "custom" ? "dialog" : prompt.kind;
  return { title: "pi needs you", body: `${context.project}, ${what}` };
}

/**
 * Push body for a blocked dialog: the project and which kind of dialog is
 * waiting, since the project alone does not say whether a decision or a picker
 * is open. The title stays on the machine: it is authored elsewhere and can quote
 * a diff.
 */
export function blockedPushBody(context: { project: string }, kind: string): string {
  const label = kind === "custom" ? "dialog" : kind;
  const article = /^[aeiou]/.test(label) ? "an" : "a";
  return `${context.project}, ${article} ${label} is waiting`;
}
