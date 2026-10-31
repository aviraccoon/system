/**
 * jobs: a `bash` tool that turns a long command into a background job instead of killing it.
 *
 * The shape, and why:
 * - A call that outlives its foreground window (60 s, `PI_JOBS_FOREGROUND_SECONDS`) is promoted.
 *   The job runs detached from a generated script, so it survives the call, the turn and pi; its
 *   wrapper writes the exit code to a status file, so a later session can report it.
 * - Completion is pushed, never polled. A model given a job id and a wait tool writes its own poll
 *   loop, which burns turns and ends with it abandoning a healthy build; the wake message is the
 *   whole reason this can be better than killing on timeout.
 * - `/jobs` is the human surface: list, tail (live), kill. The footer shows running jobs.
 *
 * `timeout` is the command's total budget, not a wait limit. A budget reached while still in the
 * foreground kills the command; a call promoted before it runs out keeps the remaining budget.
 *
 * What this tool cannot promise: commands run without a pty, so no pager and no password prompt;
 * and a promoted job's later effects are not re-classified by the permission gate, which approves
 * the command once at start.
 */

import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { isConfinedBash } from "../shared/sandbox";
import { createJobBashTool, type JobResultDetails, type KillKind } from "./bash-tool";
import { commandLabel, completionMessage, formatElapsed, jobState, statusLine, tailText } from "./format";
import {
  appendStatus,
  type JobRecord,
  jobPaths,
  jobsDir,
  listJobs,
  needsFinishStamp,
  readJob,
  shouldPrune,
} from "./paths";
import { isAlive, killJob, readLog } from "./runner";

const FOOTER_KEY = "jobs";

function mtimeSeconds(file: string): number | undefined {
  try {
    return Math.floor(fs.statSync(file).mtimeMs / 1000);
  } catch {
    return undefined;
  }
}

interface Tracked {
  id: string;
  command: string;
  child: ChildProcess;
  promoted: boolean;
  dir: string;
  /** Set when this process killed the job, so the wake is labelled from that, not from a racing file. */
  killKind?: KillKind;
}

export default function jobsExtension(pi: ExtensionAPI): void {
  const tracked = new Map<string, Tracked>();
  let ctx: ExtensionContext | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let lastFooter: string | undefined;

  const dir = (): string => jobsDir();

  function view(record: JobRecord) {
    return {
      id: record.id,
      command: record.command,
      status: record.status,
      alive: isAlive(record.status.pid),
      logBytes: record.logBytes,
      cwd: record.status.cwd,
    };
  }

  function refreshFooter(): void {
    const views = listJobs(dir()).map(view);
    const running = views.some((v) => jobState(v.status, v.alive).kind === "running");
    if (!running && ticker) {
      // The ticker exists for elapsed time, so it stops when nothing is left to time.
      clearInterval(ticker);
      ticker = undefined;
    }
    if (!ctx?.hasUI) return;
    const text = statusLine(views, Math.floor(Date.now() / 1000), ctx.cwd);
    if (text === lastFooter) return;
    lastFooter = text;
    ctx.ui.setStatus(FOOTER_KEY, text ? ctx.ui.theme.fg("muted", text) : undefined);
  }

  function startTicker(): void {
    if (ticker) return;
    ticker = setInterval(() => {
      refreshFooter();
    }, 1000);
    ticker.unref?.();
  }

  function prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const job of listJobs(dir())) {
      const logMtime = mtimeSeconds(job.paths.log);
      if (!shouldPrune(job.status, isAlive(job.status.pid), now, logMtime)) continue;
      for (const file of [job.paths.script, job.paths.cmd, job.paths.log, job.paths.status]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  function onExit(job: Tracked): void {
    // The wrapper writes the status tail before exiting; read it on the next task so the write is
    // visible, then decide whether the model is owed a wake.
    setTimeout(() => {
      tracked.delete(job.id);
      const record = readJob(dir(), job.id);
      // A child killed from outside exits without its wrapper writing a tail. This process saw the
      // exit, so it can date it: the record then ages like a finished one instead of on a guess.
      let stamped = false;
      // A kill this process asked for is known here even when the killer's own status write is still
      // in flight, which is how a budget timeout used to wake as `exit unknown`.
      // Only when the wrapper left no exit: an exit code means it reached its own tail, so a kill that
      // was refused did not stop it and the record is the truth.
      if (record && job.killKind && record.status.exit === undefined) {
        const marker = job.killKind === "timedOut" ? "timed_out=1" : "killed=1";
        const already = job.killKind === "timedOut" ? record.status.timedOut === true : record.status.killed === true;
        if (!already) {
          try {
            appendStatus(record.paths.status, [marker, `finished=${Math.floor(Date.now() / 1000)}`]);
            stamped = true;
          } catch {
            /* the record is already gone */
          }
        }
      }
      if (!stamped && record && needsFinishStamp(record.status)) {
        try {
          appendStatus(record.paths.status, [`finished=${Math.floor(Date.now() / 1000)}`]);
          stamped = true;
        } catch {
          /* the record is already gone */
        }
      }
      // The wake is built from the record as it now stands; the pre-stamp snapshot would tell the
      // model the fate is unknown right after this process recorded its finish time.
      const latest = stamped ? (readJob(dir(), job.id) ?? record) : record;
      if (job.promoted && latest) {
        const now = Math.floor(Date.now() / 1000);
        const message = completionMessage(view(latest), now, tailText(readLog(latest.paths.log)), latest.status.exit);
        // The extension API types sendMessage as void, so there is no promise to catch; a session
        // that is closing simply drops it, and the status file is the record either way.
        try {
          pi.sendMessage(
            {
              customType: "job-completion",
              content: message,
              display: true,
              details: {
                jobId: job.id,
                exitCode: latest.status.exit,
                ...(latest.status.timedOut ? { timedOut: true } : {}),
                ...(latest.status.killed ? { killed: true } : {}),
              } satisfies Partial<JobResultDetails>,
            },
            { triggerTurn: true, deliverAs: "followUp" },
          );
        } catch {
          /* the session is closing */
        }
      }
      refreshFooter();
    }, 50);
  }

  function track(started: { id: string; child: ChildProcess }, command: string): void {
    const job: Tracked = { id: started.id, command, child: started.child, promoted: false, dir: dir() };
    tracked.set(job.id, job);
    startTicker();
    started.child.once("exit", () => onExit(job));
    started.child.once("error", () => {
      tracked.delete(job.id);
      refreshFooter();
    });
    refreshFooter();
  }

  const tool = createJobBashTool({
    dir: dir(),
    hooks: {
      track: (started, command) => track(started, command),
      promoted: (id) => {
        const job = tracked.get(id);
        if (job) job.promoted = true;
      },
      killed: (id, kind) => {
        const job = tracked.get(id);
        if (job) job.killKind = kind;
      },
    },
  });
  // sandbox-bash also registers a tool named `bash`, and the permission gate auto-allows that name
  // whenever it is confined. pi keeps the first registration per name, so standing down here is
  // what keeps the confined tool in place. Load order is not guaranteed, so both conditions are
  // checked: a subagent is where the sandbox may override `bash`, and `PI_SUBAGENT` says so before
  // any extension has run. A subagent that does not load `sandbox-bash` therefore keeps the
  // built-in tool rather than this one, which is the safe direction.
  const sandboxOwnsBash = isConfinedBash("bash") || process.env.PI_SUBAGENT === "1";
  if (!sandboxOwnsBash) pi.registerTool(tool);

  function summaryLines(): string[] {
    const views = listJobs(dir()).map(view);
    if (views.length === 0) return ["No jobs."];
    const now = Math.floor(Date.now() / 1000);
    return views.map((v) => {
      const state = jobState(v.status, v.alive);
      const elapsed = formatElapsed((v.status.finishedAt ?? now) - (v.status.startedAt ?? now));
      return `${v.id}  ${state.label.padEnd(9)}  ${elapsed.padStart(6)}  ${commandLabel(v.command, 60)}`;
    });
  }

  async function killAll(target: string, ui: ExtensionContext): Promise<void> {
    const ids =
      target === "all"
        ? listJobs(dir())
            .filter((j) => jobState(view(j).status, isAlive(j.status.pid)).kind === "running")
            .map((j) => j.id)
        : [target];
    if (ids.length === 0) {
      ui.ui.notify("No running jobs to kill", "info");
      return;
    }
    for (const id of ids) {
      const result = await killJob(id, dir());
      const message = result.killed
        ? `Killed ${id}${result.reason ? ` (${result.reason})` : ""}`
        : `${id}: ${result.reason}`;
      ui.ui.notify(message, result.killed ? "info" : "error");
    }
    refreshFooter();
  }

  async function showJobs(ui: ExtensionContext): Promise<void> {
    if (!ui.hasUI) {
      pi.sendMessage(
        { customType: "jobs-list", content: summaryLines().join("\n"), display: true },
        { triggerTurn: false },
      );
      return;
    }
    const theme = ui.ui.theme;
    await ui.ui.custom<void>((tui, _theme, kb, done) => {
      let screen: "list" | "output" = "list";
      let index = 0;
      let follow = false;
      let confirmKill = false;
      let allDirs = false;
      const now = () => Math.floor(Date.now() / 1000);

      const refresh = setInterval(() => {
        if (screen === "output" && follow) tui.requestRender();
      }, 500);
      refresh.unref?.();

      // Scoped to this session's directory unless `a` asks for the machine's jobs: a job belongs to
      // the project it was started in.
      const rows = () =>
        listJobs(dir())
          .map(view)
          .filter((v) => allDirs || v.cwd === ui.cwd);

      const renderList = (width: number): string[] => {
        const all = rows();
        if (all.length === 0) return [theme.fg("muted", "No jobs."), "", theme.fg("dim", "esc closes")];
        index = Math.min(index, all.length - 1);
        const lines = all.map((v, i) => {
          const state = jobState(v.status, v.alive);
          const elapsed = formatElapsed((v.status.finishedAt ?? now()) - (v.status.startedAt ?? now()));
          const where = allDirs && v.cwd !== ui.cwd ? ` @${v.cwd?.split("/").pop() ?? "?"}` : "";
          const head = `${i === index ? ">" : " "} ${v.id}  ${state.label.padEnd(9)} ${elapsed.padStart(6)}  ${commandLabel(v.command, Math.max(10, width - 40))}${where}`;
          const color =
            state.kind === "running"
              ? "text"
              : state.kind === "ok"
                ? "success"
                : state.kind === "failed"
                  ? "error"
                  : "warning";
          return i === index ? theme.fg("accent", head) : theme.fg(color, head);
        });
        const hint = confirmKill
          ? "k again to kill, any other key cancels"
          : `↑↓ select · enter output · k kill · a ${allDirs ? "this project" : "all dirs"} · esc close`;
        return [...lines, "", theme.fg(confirmKill ? "warning" : "dim", hint)];
      };

      const renderOutput = (width: number): string[] => {
        const all = rows();
        const v = all[Math.min(index, all.length - 1)];
        if (!v) return [theme.fg("muted", "Job is gone."), "", theme.fg("dim", "esc back")];
        const state = jobState(v.status, v.alive);
        const elapsed = formatElapsed((v.status.finishedAt ?? now()) - (v.status.startedAt ?? now()));
        const header = `${v.id}  ${state.label}  ${elapsed}  ${commandLabel(v.command, Math.max(10, width - 40))}`;
        const log = tailText(readLog(jobPaths(dir(), v.id).log), 200, 200 * width);
        const body = log ? log.split("\n").slice(-24) : [theme.fg("muted", "(no output yet)")];
        const hint = `${follow ? "following · " : ""}f follow · k kill · esc back`;
        return [theme.fg("accent", header), "", ...body, "", theme.fg(follow ? "warning" : "dim", hint)];
      };

      return {
        render(width: number): string[] {
          const lines = screen === "list" ? renderList(width) : renderOutput(width);
          return lines.map((line) => truncateToWidth(line, width));
        },
        invalidate() {},
        handleInput(data: string): void {
          const all = rows();
          if (screen === "list") {
            if (kb.matches(data, "tui.select.up")) {
              index = index === 0 ? Math.max(0, all.length - 1) : index - 1;
              confirmKill = false;
              tui.requestRender();
              return;
            }
            if (kb.matches(data, "tui.select.down")) {
              index = index === all.length - 1 ? 0 : index + 1;
              confirmKill = false;
              tui.requestRender();
              return;
            }
            if (kb.matches(data, "tui.select.confirm") && all.length > 0) {
              screen = "output";
              confirmKill = false;
              tui.requestRender();
              return;
            }
            if (data === "a") {
              allDirs = !allDirs;
              index = 0;
              confirmKill = false;
              tui.requestRender();
              return;
            }
            if (data === "k" && all[index]) {
              if (!confirmKill) {
                confirmKill = true;
                tui.requestRender();
                return;
              }
              confirmKill = false;
              const id = all[index].id;
              void killJob(id, dir()).then(() => {
                tui.requestRender();
                refreshFooter();
              });
              return;
            }
            if (kb.matches(data, "tui.select.cancel")) {
              done();
              return;
            }
            confirmKill = false;
            tui.requestRender();
            return;
          }
          if (kb.matches(data, "tui.select.cancel")) {
            screen = "list";
            follow = false;
            tui.requestRender();
            return;
          }
          if (data === "f") {
            follow = !follow;
            tui.requestRender();
            return;
          }
          if (data === "k" && all[index]) {
            const id = all[index].id;
            void killJob(id, dir()).then(() => {
              tui.requestRender();
              refreshFooter();
            });
          }
        },
        dispose: () => clearInterval(refresh),
      };
    });
    refreshFooter();
  }

  pi.registerCommand("jobs", {
    description: "List background jobs; /jobs kill <id|all>",
    handler: async (args, ui) => {
      ctx = ui;
      const trimmed = args.trim();
      if (trimmed.startsWith("kill")) {
        const target = trimmed.slice("kill".length).trim();
        if (!target) {
          ui.ui.notify("Usage: /jobs kill <id|all>", "warning");
          return;
        }
        await killAll(target, ui);
        return;
      }
      await showJobs(ui);
    },
  });

  pi.on("session_start", (_event, sessionCtx) => {
    ctx = sessionCtx;
    prune();
    refreshFooter();
    startTicker();
  });

  pi.on("session_shutdown", () => {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    if (ctx?.hasUI) ctx.ui.setStatus(FOOTER_KEY, undefined);
    lastFooter = undefined;
  });
}
