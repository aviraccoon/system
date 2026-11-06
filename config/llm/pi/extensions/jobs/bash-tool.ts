/**
 * The `bash` tool, re-registered so a long command becomes a job instead of dying.
 *
 * Foreground behaviour is pi's: stdout and stderr, a non-zero exit reported, the same parameter
 * names. The difference is what happens when the call outlives its foreground window, and what a
 * `timeout` means: it is the command's total budget, not the time the tool is willing to wait. A
 * budget the call reaches while still in the foreground kills it there; a call that merely runs
 * longer than the foreground window is promoted and keeps its remaining budget.
 *
 * What this tool cannot promise: commands run without a pty, so no pager and no password prompt;
 * and a promoted job's later effects are not re-classified by the permission gate, which approves
 * the command once at start.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortOutcome, commandLabel, formatElapsed, tailWithNotice, timeoutNotice } from "./format";
import { isSettled, newJobId, readJob, removeJob } from "./paths";
import { foregroundWaitMs, killJob, readLog, type StartedJob, startJob, waitForExit } from "./runner";

export const MAX_TIMEOUT_SECONDS = 3600;

/** pi's shell-tool injection (`resolveSpawnContext` in `dist/core/tools/bash.js`). */
const SESSION_ENV_VARS = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;

/** The only parts of the context the injection reads; renaming one in pi fails here. */
export type SessionContext = Pick<ExtensionContext, "sessionManager" | "model" | "thinkingLevel">;

/** The review-gate git hooks key off `PI_SESSION_ID`. */
export function sessionEnv(ctx: SessionContext | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SESSION_ENV_VARS) delete env[key];
  if (ctx === undefined) return env;
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  return env;
}

export const bashJobParameters = Type.Object({
  command: Type.String({ description: "Shell command to run." }),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Total time budget in seconds for the whole command (optional, no default, must be positive). A call still running after the foreground window becomes a background job that keeps the rest of the budget; the command is killed when the budget runs out.",
    }),
  ),
});

export type KillKind = "timedOut" | "killed";

export interface JobToolHooks {
  /** Start tracking a job's exit (wake, footer). Returns nothing; the runner owns the child. */
  track(job: StartedJob, command: string): void;
  /** Called once the call returned while the job was still running. */
  promoted(id: string): void;
  /**
   * Called when this tool killed the job, so the exit handler can label the wake from what it knows
   * rather than from a status file the killer may not have finished writing.
   */
  killed?(id: string, kind: KillKind): void;
}

/** Structured result details, so a session log carries the job id as data instead of only in prose. */
export interface JobResultDetails {
  /** Every result names its job; the completion message repeats it, so a reader can join the two. */
  jobId: string;
  /** Set only on the result that returned while the job was still running. */
  promoted?: boolean;
  /** The command's total budget, present when one was given. */
  budgetSeconds?: number;
  /** The exit code, where one exists. */
  exitCode?: number;
  /** The signal that ended the wrapper, when nothing wrote an exit code. */
  signal?: string;
  /** The budget ran out. */
  timedOut?: boolean;
  /** A kill ended it. */
  killed?: boolean;
  /** The spawn error's message, when the command never started. */
  spawnFailed?: string;
  /** Why the kill could not be delivered. */
  stopFailed?: string;
}

export interface JobToolOptions {
  dir: string;
  hooks: JobToolHooks;
  foregroundMs?: number;
}

async function settleStatus(dir: string, id: string, ms: number) {
  const deadline = Date.now() + ms;
  let record = readJob(dir, id);
  while (Date.now() < deadline) {
    if (record && isSettled(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 100));
    record = readJob(dir, id);
  }
  return record;
}

function text(value: string, details: JobResultDetails, isError = false) {
  return {
    content: [{ type: "text" as const, text: value }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/** The result the model sees when its call did not finish in the foreground window. */
export function promotionText(
  id: string,
  command: string,
  elapsed: number,
  logPath: string,
  budgetSeconds?: number,
): string {
  const budget =
    budgetSeconds === undefined ? "no deadline" : `killed when its ${formatElapsed(budgetSeconds)} budget runs out`;
  return [
    `Still running after ${formatElapsed(elapsed)}: backgrounded as job ${id} (${budget}).`,
    "",
    `Output so far is in ${logPath}, and /jobs shows it live. Its completion will arrive as a message. Do NOT poll for it: no sleep, ps, pgrep, tail or repeated calls. Do other work, or end your reply and wait to be woken.`,
    "",
    `Command: ${commandLabel(command, 100)}`,
  ].join("\n");
}

export function createJobBashTool(options: JobToolOptions) {
  const foregroundMs = options.foregroundMs ?? foregroundWaitMs();
  return {
    name: "bash",
    label: "bash",
    description:
      "Run a shell command in the current working directory. Returns stdout and stderr, truncated to the last 2000 lines or 50KB. A command still running after the foreground window becomes a background job: the call returns with a job id, its completion arrives as a message, and its output is readable with /jobs. `timeout` is the command's total budget in seconds, not a wait limit.",
    parameters: bashJobParameters,
    promptGuidelines: [
      "A bash call that outlives its foreground window is promoted to a background job and its completion arrives as a message. Never poll a job (no sleep, ps, pgrep, tail loops); do other work or end the reply.",
    ],

    async execute(
      _toolCallId: string,
      params: { command: string; timeout?: number },
      signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: ExtensionContext,
    ) {
      if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0)) {
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      // Node clamps a longer timer to 1 ms, which would kill the command at once instead of running it.
      if (params.timeout !== undefined && params.timeout > MAX_TIMEOUT_SECONDS) {
        throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
      }
      const startedAt = Math.floor(Date.now() / 1000);
      const budgetSeconds = params.timeout;
      const job = startJob({
        id: newJobId(),
        command: params.command,
        cwd: ctx?.cwd ?? process.cwd(),
        dir: options.dir,
        budgetSeconds,
        env: sessionEnv(ctx),
        // Captured here rather than at load: the tool's own context carries the session that made
        // the call, which is what a bulk action in /jobs must stay inside.
        session: ctx?.sessionManager.getSessionId(),
      });
      options.hooks.track(job, params.command);
      // The budget belongs to the tool, not to the extension's hook: a call must behave the same way
      // whoever is watching it.
      const budgetTimer =
        budgetSeconds === undefined
          ? undefined
          : setTimeout(() => {
              // Declare the kill before asking for it: the extension learns about the exit through a
              // delayed timer, so the marker may not be on disk yet when it labels the wake.
              options.hooks.killed?.(job.id, "timedOut");
              void killJob(job.id, options.dir, { timedOut: true });
            }, budgetSeconds * 1000);
      job.child.once("exit", () => {
        if (budgetTimer) clearTimeout(budgetTimer);
      });

      const budgetMs = budgetSeconds === undefined ? undefined : budgetSeconds * 1000;
      const windowMs = budgetMs === undefined ? foregroundMs : Math.min(foregroundMs, budgetMs);

      const exited = await waitForExit(job.child, windowMs, signal);
      // Escape is the human cancelling the command, not a promotion: kill it, like the built-in tool
      // does, and do not wake the model for work the user stopped.
      const killAttempt = signal?.aborted && !exited ? await killJob(job.id, options.dir) : undefined;
      const abortRecord = killAttempt ? readJob(options.dir, job.id) : undefined;
      const settled = job.child.exitCode !== null || (abortRecord !== undefined && isSettled(abortRecord.status));
      const outcome = abortOutcome({
        aborted: signal?.aborted === true,
        exited,
        killed: killAttempt?.killed === true,
        finished: settled,
      });
      if (outcome === "killed" || outcome === "already-finished") {
        if (budgetTimer) clearTimeout(budgetTimer);
      }
      if (outcome === "killed") {
        options.hooks.killed?.(job.id, "killed");
        const output = tailWithNotice(readLog(job.paths.log), job.paths.log);
        return text(`${output}\n\nCommand killed`, { jobId: job.id, killed: true }, true);
      }
      if (outcome === "failed") {
        // The job is still running and keeps its budget; say so instead of promoting work the user
        // tried to stop.
        const output = tailWithNotice(readLog(job.paths.log), job.paths.log);
        return text(
          `${output}\n\nCommand could not be stopped: ${killAttempt?.reason ?? "unknown"}`,
          { jobId: job.id, stopFailed: killAttempt?.reason ?? "unknown" },
          true,
        );
      }
      // "none" either means the call was never aborted, or that it finished on its own: both fall
      // through to the completed path or to promotion.
      const spawnFailure = job.failure();
      if (spawnFailure) {
        if (budgetTimer) clearTimeout(budgetTimer);
        // Nothing ran, so leave no record behind rather than a status that reads as a lost job.
        removeJob(options.dir, job.id);
        return text(
          `Command could not start: ${spawnFailure.message}`,
          { jobId: job.id, spawnFailed: spawnFailure.message },
          true,
        );
      }
      // The status tail is what says how a job ended, and it lands after the process does. A budget
      // expiring inside the window makes that gap long enough to matter (SIGTERM, a poll, SIGKILL),
      // so read the record rather than racing it.
      const budgetInsideWindow = budgetMs !== undefined && budgetMs <= windowMs;
      const record = await settleStatus(options.dir, job.id, budgetInsideWindow ? 3500 : 300);
      const timedOut = record?.status.timedOut === true;
      const killed = record?.status.killed === true;
      if (exited || job.child.exitCode !== null || (record !== undefined && isSettled(record.status))) {
        const output = tailWithNotice(readLog(job.paths.log), job.paths.log);
        const exitCode = record?.status.exit ?? job.child.exitCode;
        if (timedOut) {
          const notice = timeoutNotice(budgetSeconds, record?.logBytes ?? 0, params.command);
          return text(
            `${output}\n\n${notice}`,
            { jobId: job.id, timedOut: true, exitCode: exitCode ?? undefined },
            true,
          );
        }
        if (killed) {
          return text(
            `${output}\n\nCommand killed`,
            { jobId: job.id, killed: true, exitCode: exitCode ?? undefined },
            true,
          );
        }
        if (exitCode === 0) return text(output, { jobId: job.id, exitCode: 0 });
        if (exitCode == null) {
          const signal = job.child.signalCode ?? undefined;
          return text(
            `${output}\n\nCommand terminated by signal ${signal ?? "unknown"}`,
            signal ? { jobId: job.id, signal } : { jobId: job.id },
            true,
          );
        }
        return text(`${output}\n\nCommand exited with code ${exitCode}`, { jobId: job.id, exitCode }, true);
      }

      options.hooks.promoted(job.id);
      const elapsed = Math.floor(Date.now() / 1000) - startedAt;
      return text(promotionText(job.id, params.command, Math.max(elapsed, 1), job.paths.log, budgetSeconds), {
        jobId: job.id,
        promoted: true,
        budgetSeconds,
      });
    },
  };
}
