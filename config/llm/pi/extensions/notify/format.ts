/**
 * Notification content. Two audiences with different exposure:
 *
 * - The terminal frame is local, so it can carry the last command and a snippet
 *   of the answer.
 * - The push leaves the machine (ntfy.sh by default: anyone holding the topic
 *   can read it), so it carries the project, counts, durations, two outcome
 *   flags and the blocked dialog's kind: the last tool failed, the answer was
 *   truncated, a confirm or a picker is waiting. Never a command, never model
 *   output, and never a dialog title: titles are authored by other extensions and
 *   can quote a diff.
 */

import { basename } from "node:path";
import { collectToolPaths } from "../shared/edit-tools";

export interface Note {
  title: string;
  body: string;
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
export function settledNote(facts: RunFacts, context: SettledContext): Note {
  const duration = durationLabel(context.now - facts.startedAt);
  const title = duration ? `pi done, ${duration}` : "pi done";
  const parts = [context.project];
  if (facts.toolCalls > 0) parts.push(`${facts.toolCalls} tools`);
  if (facts.lastAction) parts.push(facts.lastAction);
  if (facts.lastToolError) parts.push(`FAILED ${facts.lastToolError}`);
  if (facts.truncated) parts.push("truncated");
  if (context.session) parts.push(context.session);
  if (context.snippet) parts.push(`"${oneLine(context.snippet, MAX_SNIPPET)}"`);
  return { title, body: parts.join(", ") };
}

/**
 * Push body for a settled run: project, duration, counts and outcome flags. The
 * last command and the answer stay on the machine.
 */
export function settledPushBody(facts: RunFacts, context: SettledContext): string {
  const parts = [context.project];
  const duration = durationLabel(context.now - facts.startedAt);
  if (duration) parts.push(duration);
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
