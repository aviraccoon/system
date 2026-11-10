/**
 * Presentation of job state: elapsed time, state labels, the one-line footer and the tail of a
 * log. Pure functions, so the CLI text and the overlay agree and both are testable without pi.
 */

import { isSettled, type JobStatus } from "../shared/job-store";

export interface JobView {
  id: string;
  command: string;
  /** `subagent` for a background dispatch, `job` for a shell command. */
  kind: string;
  status: JobStatus;
  alive: boolean;
  logBytes: number;
  /** Where the command ran. A job belongs to the project it was started in. */
  cwd?: string;
  /** The pi session that started it, for the `@other` marker and for what a bulk action may touch. */
  session?: string;
}

export type JobStateKind = "running" | "ok" | "failed" | "killed" | "timedOut" | "finished";

export interface JobState {
  kind: JobStateKind;
  label: string;
}

const SUBAGENT_PREFIX = "subagent  ";

/** The list's subject: a subagent run is labelled, since its "command" is a task. The prefix is
 *  charged to `width`, and dropped when it cannot fit, so the title never outgrows the row. */
export function viewTitle(view: Pick<JobView, "kind" | "command">, width = 60): string {
  // The label needs a few characters of task to say anything, or the row reads `subagent  …`.
  const prefix = view.kind === "subagent" && SUBAGENT_PREFIX.length + 4 <= width ? SUBAGENT_PREFIX : "";
  return prefix + commandLabel(view.command, Math.max(1, width - prefix.length));
}

/** `8s`, `3m12s`, `1h04m`, `2d3h`: the shape a person reads at a glance, never negative. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest === 0 ? `${m}m` : `${m}m${String(rest).padStart(2, "0")}s`;
  }
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}m`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return h === 0 ? `${d}d` : `${d}d${h}h`;
}

/**
 * A job is running only while its status has no exit, its process is alive, and nobody killed it.
 * `alive` comes from a pid probe, which is the only part that cannot be decided from the file
 * alone: a status file left by a killed pi has no exit line.
 */
export function jobState(status: JobStatus, alive: boolean): JobState {
  if (status.failed) return { kind: "failed", label: "failed" };
  if (status.timedOut) return { kind: "timedOut", label: "timed out" };
  if (status.killed) return { kind: "killed", label: "killed" };
  if (status.exit === undefined) {
    // The distinction is worth keeping: the wrapper ended without writing an exit, which the record
    // dates, versus nothing knowing how this ended, which is lost.
    if (status.finishedAt !== undefined) return { kind: "finished", label: "finished" };
    return alive ? { kind: "running", label: "running" } : { kind: "failed", label: "lost" };
  }
  return status.exit === 0 ? { kind: "ok", label: "exit 0" } : { kind: "failed", label: `exit ${status.exit}` };
}

export function elapsedSeconds(view: JobView, nowSeconds: number): number {
  const start = view.status.startedAt ?? nowSeconds;
  const end = view.status.finishedAt ?? nowSeconds;
  return end - start;
}

/** How much of a declared budget is spent, named for the colour a reader sees. */
export type BudgetLevel = "ok" | "warning" | "error";

export interface BudgetView {
  text: string;
  level: BudgetLevel;
}

/** The share of the budget at which a reader should start noticing, then expecting the kill. */
const BUDGET_SOON = 0.75;
const BUDGET_LATE = 0.9;

/**
 * `3m12s/5m` for a job whose caller declared a budget, with the pressure it represents. A settled job
 * keeps its ratio but never reads as late: there is nothing left for the budget to run out of.
 */
export function budgetView(status: JobStatus, nowSeconds: number): BudgetView | undefined {
  const budget = status.budgetSeconds;
  if (budget === undefined || budget <= 0) return undefined;
  const elapsed = Math.max(0, (status.finishedAt ?? nowSeconds) - (status.startedAt ?? nowSeconds));
  const spent = elapsed / budget;
  const level: BudgetLevel =
    isSettled(status) || spent < BUDGET_SOON ? "ok" : spent < BUDGET_LATE ? "warning" : "error";
  return { text: `${formatElapsed(elapsed)}/${formatElapsed(budget)}`, level };
}

/** A job that did not succeed: a non-zero exit, a kill, a timeout. */
export function jobFailed(status: JobStatus): boolean {
  if (status.failed === true) return true;
  if (status.killed === true || status.timedOut === true) return true;
  return status.exit !== undefined && status.exit !== 0;
}

/** pi's own limits, so an override does not quietly return less output than the tool it replaced. */
export const TOOL_MAX_LINES = 2000;
export const TOOL_MAX_BYTES = 50 * 1024;

/** The tail, plus a notice naming the log when anything was cut. */
export function tailWithNotice(
  text: string,
  logPath: string,
  maxLines = TOOL_MAX_LINES,
  maxBytes = TOOL_MAX_BYTES,
): string {
  if (!text.trim()) return "(no output)";
  const cut = tailText(text, maxLines, maxBytes);
  if (cut === text) return text;
  return `${cut}\n\n[Showing the last part of the output. Full output: ${logPath}]`;
}

/** Keep the last `maxLines` lines and at most `maxBytes` of the tail, on a line boundary. */
export function tailText(text: string, maxLines = 80, maxBytes = 16_000): string {
  let out = text;
  if (Buffer.byteLength(out) > maxBytes) {
    const buf = Buffer.from(out, "utf8");
    out = buf.subarray(buf.length - maxBytes).toString("utf8");
    // Drop the partial first line the cut created.
    const nl = out.indexOf("\n");
    if (nl >= 0) out = out.slice(nl + 1);
  }
  const lines = out.split("\n");
  if (lines.length > maxLines) out = lines.slice(-maxLines).join("\n");
  return out;
}

/**
 * One line per running job, two at most: the footer must never grow into a paragraph. Scoped to
 * `cwd` when given, because a job belongs to the project it was started in; work running in another
 * directory is counted, not named, so it never looks like this project's.
 */
export function statusLine(views: JobView[], nowSeconds: number, cwd?: string): string | undefined {
  const running = views.filter((v) => jobState(v.status, v.alive).kind === "running");
  const inScope = cwd === undefined ? running : running.filter((v) => v.cwd === cwd);
  const elsewhere = running.length - inScope.length;
  if (inScope.length === 0) return elsewhere > 0 ? `jobs ${elsewhere} elsewhere` : undefined;
  const shown = inScope
    .slice(0, 2)
    .map((v) => `${viewTitle(v, 24)} ${formatElapsed(elapsedSeconds(v, nowSeconds))}`)
    .join(" · ");
  const more = inScope.length > 2 ? ` +${inScope.length - 2}` : "";
  const rest = elsewhere > 0 ? ` · +${elsewhere} elsewhere` : "";
  return `jobs ${inScope.length} · ${shown}${more}${rest}`;
}

/**
 * What an escape should report. `killJob` failing is not proof the job finished: it fails on a record
 * it cannot read, a record with no pid, and a signal it was refused.
 */
export type AbortOutcome = "none" | "killed" | "already-finished" | "failed";

export function abortOutcome(input: {
  aborted: boolean;
  exited: boolean;
  killed: boolean;
  finished: boolean;
}): AbortOutcome {
  if (!input.aborted || input.exited) return "none";
  if (input.killed) return "killed";
  return input.finished ? "already-finished" : "failed";
}

/** A count of records with the noun agreeing: `1 finished record`, `3 finished records`. */
export function recordCount(count: number): string {
  return `${count} finished record${count === 1 ? "" : "s"}`;
}

/** A byte count as a person reads it: `512 B`, `12.3 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const shown = unit === 0 ? Math.round(value) : value < 10 ? value.toFixed(1) : Math.round(value);
  return `${shown} ${units[unit]}`;
}

/**
 * The command as it reads above its own output. The first line gets a prompt so a heredoc's first
 * line is not mistaken for output; continuation lines keep their own indentation.
 */
export function commandBlock(command: string): string[] {
  const lines = command.replace(/\n+$/, "").split("\n");
  return lines.map((line, index) => (index === 0 ? `$ ${line}` : line));
}

/**
 * A log's lines for the viewer, tail-capped with a line that says what was cut. Wrapping a
 * megabyte of output on every refresh is the thing to avoid, not keeping the old bytes.
 */
export function logLines(text: string, maxLines = 2000): string[] {
  const lines = text.replace(/\n$/, "").split("\n");
  if (lines.length <= maxLines) return lines;
  return [`… ${lines.length - maxLines} lines above, full log on disk`, ...lines.slice(-maxLines)];
}

/** First line, argument-free: `docker compose up` reads better than a truncated absolute path. */
export function commandLabel(command: string, width = 60): string {
  const line = command.split("\n")[0]?.trim() ?? "";
  if (line.length <= width) return line || "(empty)";
  return `${line.slice(0, width - 1)}…`;
}

/**
 * What a wake carries of a log: the tail always, plus the head when the job failed and the log was read
 * whole. The head gives way so the tail is never empty.
 */
export interface WakeSlices {
  head?: string;
  tail: string;
  /** Lines neither block shows. */
  omitted: number;
  /** The text is the end of a capped read, so `omitted` cannot count what came before it. */
  capped?: boolean;
}

const WAKE_HEAD_LINES = 20;
const WAKE_TAIL_LINES = 80;
/** A block is bounded twice: by lines, and by bytes so a log of long lines cannot fill it. */
const WAKE_SLICE_BYTES = 8_000;
/** One line may not use a whole block. A minified blob or a one-line stack would otherwise own it. */
const WAKE_LINE_CHARS = 400;

/** A line over the per-line cap keeps its start, which is where a blob's keys or an error's text are. */
function clampLine(line: string): string {
  if (line.length <= WAKE_LINE_CHARS) return line;
  let cut = line.slice(0, WAKE_LINE_CHARS - 1);
  const last = cut.charCodeAt(cut.length - 1);
  // Never split a surrogate pair: the fragment would not encode.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

interface Block {
  text: string;
  /** Lines the byte budget kept out of the block. */
  dropped: number;
  /** At least one line was shortened. */
  shortened: boolean;
}

/** Whole lines from one end, each line capped, until the line or byte budget runs out. */
function clampBlock(lines: string[], fromEnd: boolean, maxLines: number, maxBytes: number): Block {
  const ordered = fromEnd ? [...lines].reverse() : lines;
  const picked: string[] = [];
  let bytes = 0;
  let shortened = false;
  for (const line of ordered) {
    if (picked.length >= maxLines) break;
    const clamped = clampLine(line);
    if (clamped !== line) shortened = true;
    const size = Buffer.byteLength(clamped) + 1;
    if (bytes + size > maxBytes) break;
    picked.push(clamped);
    bytes += size;
  }
  return { text: (fromEnd ? picked.reverse() : picked).join("\n"), dropped: lines.length - picked.length, shortened };
}

/**
 * A wake is unasked-for context, so it carries a reading of the log rather than the file. A failing
 * build puts its error above the tail, which is the part a wake would otherwise carry alone.
 * `wholeLog` false says `text` is the tail of a capped read, where a head cannot be known.
 */
export function wakeSlices(text: string, failed: boolean, wholeLog = true): WakeSlices {
  const body = text.replace(/\n+$/, "");
  if (!body.trim()) return { tail: "", omitted: 0 };
  const lines = body.split("\n");

  // A failing log that fits both budgets, line by line, is sent in full: a line count is not worth
  // hiding the lines the error is on.
  if (failed && wholeLog) {
    const whole = clampBlock(lines, false, WAKE_HEAD_LINES + WAKE_TAIL_LINES, WAKE_SLICE_BYTES);
    if (whole.dropped === 0 && !whole.shortened) return { tail: whole.text, omitted: 0 };
  }

  // The tail is the log's end, which a wake can never do without. The head is the first lines, taken
  // from what the tail is not showing: its own byte budget can drop lines from the tail's start, and
  // those are exactly the lines the head exists for, so it takes them back.
  const tailStart = Math.max(0, lines.length - WAKE_TAIL_LINES);
  const tail = clampBlock(lines.slice(tailStart), true, WAKE_TAIL_LINES, WAKE_SLICE_BYTES);
  const headEnd = failed && wholeLog ? Math.min(WAKE_HEAD_LINES, tailStart + tail.dropped) : 0;
  const head = headEnd > 0 ? clampBlock(lines.slice(0, headEnd), false, WAKE_HEAD_LINES, WAKE_SLICE_BYTES) : undefined;
  return {
    ...(head === undefined ? {} : { head: head.text }),
    tail: tail.text,
    // Every line kept out of either block is counted, so the notice never understates what is missing.
    omitted: wholeLog ? tailStart - headEnd + tail.dropped + (head?.dropped ?? 0) : 0,
    ...(wholeLog ? {} : { capped: true }),
  };
}

/**
 * The message the agent receives when a promoted job finishes. The log's path rides along whenever
 * the body was cut or the job failed: a reader that cannot find the line it needs has to be told
 * where the rest is, and a wake is the one message nobody asked for.
 */
export function completionMessage(
  view: JobView,
  nowSeconds: number,
  slices: WakeSlices,
  exitCode: number | undefined,
  logPath: string,
): string {
  const state = jobState(view.status, false);
  const elapsed = formatElapsed(elapsedSeconds(view, nowSeconds));
  const code = exitCode ?? view.status.exit;
  const detail = code !== undefined ? `exit ${code}` : state.kind === "finished" ? "exit unknown" : state.label;
  const cut = slices.omitted > 0 || slices.capped === true;
  const blocks = [`[job ${view.id} finished: ${detail} after ${elapsed}]`];
  if (slices.head) blocks.push(slices.head);
  if (cut) {
    blocks.push(
      slices.capped === true
        ? "… further output omitted"
        : `… ${slices.omitted} line${slices.omitted === 1 ? "" : "s"} omitted`,
    );
  }
  if (slices.tail) blocks.push(slices.tail);
  if (cut || jobFailed(view.status)) blocks.push(`Full log: ${logPath}`);
  return blocks.join("\n\n");
}

/**
 * A timed-out job's sentence, plus the case where the log is empty although the command produced
 * output: a pipe only survives the kill if it flushed first. Which pipe it was does not matter, so
 * the wording does not guess.
 */
export function timeoutNotice(budgetSeconds: number | undefined, logBytes: number, command: string): string {
  const budget = budgetSeconds === undefined ? "its budget" : `its ${formatElapsed(budgetSeconds)} budget`;
  const base = `Command timed out after ${budget}`;
  if (logBytes > 0 || !command.includes("|")) return base;
  return `${base}. No output was captured: the command pipes its output, and the pipe may have been killed before it flushed`;
}
