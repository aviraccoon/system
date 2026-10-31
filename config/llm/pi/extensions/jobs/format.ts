/**
 * Presentation of job state: elapsed time, state labels, the one-line footer and the tail of a
 * log. Pure functions, so the CLI text and the overlay agree and both are testable without pi.
 */

import type { JobStatus } from "./paths";

export interface JobView {
  id: string;
  command: string;
  status: JobStatus;
  alive: boolean;
  logBytes: number;
  /** Where the command ran. A job belongs to the project it was started in. */
  cwd?: string;
}

export type JobStateKind = "running" | "ok" | "failed" | "killed" | "timedOut" | "finished";

export interface JobState {
  kind: JobStateKind;
  label: string;
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
    .map((v) => `${commandLabel(v.command, 24)} ${formatElapsed(elapsedSeconds(v, nowSeconds))}`)
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

/** First line, argument-free: `docker compose up` reads better than a truncated absolute path. */
export function commandLabel(command: string, width = 60): string {
  const line = command.split("\n")[0]?.trim() ?? "";
  if (line.length <= width) return line || "(empty)";
  return `${line.slice(0, width - 1)}…`;
}

/** The message the agent receives when a promoted job finishes. */
export function completionMessage(
  view: JobView,
  nowSeconds: number,
  tail: string,
  exitCode: number | undefined,
): string {
  const state = jobState(view.status, false);
  const elapsed = formatElapsed(elapsedSeconds(view, nowSeconds));
  const code = exitCode ?? view.status.exit;
  const detail = code !== undefined ? `exit ${code}` : state.kind === "finished" ? "exit unknown" : state.label;
  const header = `[job ${view.id} finished: ${detail} after ${elapsed}]`;
  const body = tail.trim() ? `\n\n${tail.trimEnd()}` : "";
  return `${header}${body}`;
}
