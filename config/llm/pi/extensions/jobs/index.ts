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
 * - `/jobs` is the human surface: a bottom panel of this project's running jobs, with the full command
 *   and a live, scrollable log. Both views are laid out from `panelHeight` and the frame that carries
 *   them from `dialogHeight`; a render past the screen loses its bottom, the hint line first.
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
import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth } from "@earendil-works/pi-tui";
import { copyText, openFolder } from "../shared/host-actions";
import { isConfinedBash } from "../shared/sandbox";
import { ScrollableText } from "../shared/scrollable-text";
import { shortcutLabel } from "../shared/shortcuts";
import { createJobBashTool, type JobResultDetails, type KillKind } from "./bash-tool";
import {
  type BudgetLevel,
  budgetView,
  commandBlock,
  commandLabel,
  completionMessage,
  elapsedSeconds,
  formatBytes,
  formatElapsed,
  type JobView,
  jobFailed,
  jobState,
  logLines,
  recordCount,
  statusLine,
  tailText,
  wakeSlices,
} from "./format";
import { DIALOG_RULE_ROWS, listBodyHeight, panelHeight, splitOutput, windowRows } from "./layout";
import {
  appendStatus,
  ensureJobsDir,
  type JobRecord,
  jobPaths,
  jobsDir,
  listJobs,
  needsFinishStamp,
  readJob,
  removeJob,
  shouldPrune,
  stampMarker,
} from "./paths";
import { isAlive, killJob, LOG_READ_LIMIT, readLog } from "./runner";
import { cycleScope, hiddenFinished, type JobScope, scopeLabel, startedHere, visibleJobs } from "./scope";
import { JOB_SHORTCUTS } from "./shortcuts";
import { WakeLedger } from "./wakes";

const FOOTER_KEY = "jobs";

/** `ctrl+k` reads as `Ctrl+K` in a hint, from the same table the matchers use. */
const keyOf = (id: keyof typeof JOB_SHORTCUTS): string => shortcutLabel(JOB_SHORTCUTS[id]);

function fileSize(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
  } catch {
    return undefined;
  }
}

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

/** A completion message, kept until the session shows it. */
interface Wake {
  jobId: string;
  message: string;
  exitCode?: number;
  timedOut?: boolean;
  killed?: boolean;
}

export default function jobsExtension(pi: ExtensionAPI): void {
  const tracked = new Map<string, Tracked>();
  let ctx: ExtensionContext | undefined;
  let ticker: NodeJS.Timeout | undefined;
  let lastFooter: string | undefined;

  const dir = (): string => jobsDir();

  function view(record: JobRecord): JobView {
    return {
      id: record.id,
      command: record.command,
      status: record.status,
      alive: isAlive(record.status.pid),
      logBytes: record.logBytes,
      cwd: record.status.cwd,
      session: record.status.session,
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
      removeJob(dir(), job.id);
    }
  }

  function onExit(job: Tracked): void {
    // The wrapper writes the status tail before exiting; read it on the next task so the write is
    // visible, then decide whether the model is owed a wake.
    setTimeout(() => {
      tracked.delete(job.id);
      let record = readJob(dir(), job.id);
      // A kill this process asked for is known here even when the killer's own status write is still
      // in flight, which is how a budget timeout used to wake as `exit unknown`. Only when the wrapper
      // left no exit: an exit code means it reached its own tail, so a kill that was refused did not
      // stop it and the record is the truth.
      if (record && job.killKind && record.status.exit === undefined) {
        const marker = job.killKind === "timedOut" ? "timed_out=1" : "killed=1";
        stampMarker(record.paths.status, marker);
        record = readJob(dir(), job.id) ?? record;
      }
      // A child killed from outside exits without its wrapper writing a tail. This process saw the
      // exit, so it can date it: the record then ages like a finished one instead of on a guess.
      if (record && needsFinishStamp(record.status)) {
        try {
          appendStatus(record.paths.status, [`finished=${Math.floor(Date.now() / 1000)}`]);
          record = readJob(dir(), job.id) ?? record;
        } catch {
          /* the record is already gone */
        }
      }
      if (job.promoted && record) {
        const now = Math.floor(Date.now() / 1000);
        // A wake is unasked-for context: it carries the tail, plus the head of a failed job because
        // that is where the error sits, plus the log's path whenever anything was cut or the job
        // failed. A log past the read cap has no head to offer: its first line is the middle of the file.
        const wholeLog = record.logBytes <= LOG_READ_LIMIT;
        const slices = wakeSlices(readLog(record.paths.log), jobFailed(record.status), wholeLog);
        sendWake({
          jobId: job.id,
          message: completionMessage(view(record), now, slices, record.status.exit, record.paths.log),
          exitCode: record.status.exit,
          timedOut: record.status.timedOut,
          killed: record.status.killed,
        });
      }
      refreshFooter();
    }, 50);
  }

  const owed = new WakeLedger<Wake>((value) => value.jobId);

  /**
   * Send a completion and remember it. `sendMessage` has no receipt, so delivery is only known when
   * the session shows the message; the loss that matters is an abort clearing the queue it waits in.
   */
  function sendWake(wake: Wake): void {
    owed.owe(wake);
    try {
      pi.sendMessage(
        {
          customType: "job-completion",
          content: wake.message,
          display: true,
          details: {
            jobId: wake.jobId,
            exitCode: wake.exitCode,
            ...(wake.timedOut ? { timedOut: true } : {}),
            ...(wake.killed ? { killed: true } : {}),
          } satisfies Partial<JobResultDetails>,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      /* the session is closing; the status file is the record either way */
    }
  }

  // A queued message is shown as it starts, which is the only delivery receipt a custom message has.
  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== "job-completion") return;
    const jobId = (message.details as { jobId?: string } | undefined)?.jobId;
    if (jobId !== undefined) owed.delivered(jobId);
  });

  // Escape aborts the run and clears the queue the wake is waiting in, without showing it anywhere.
  // Re-send once at the first settle after an abort, which is also the moment that queue was emptied;
  // a normal settle never needs it, because the loop only ends after it has drained its follow-ups.
  pi.on("agent_settled", (event) => {
    if (!event.aborted) return;
    for (const wake of owed.takeForRetry()) sendWake(wake);
  });

  /**
   * Say a kill is coming before asking for it. The wrapper cannot report a killed job, and the exit
   * handler runs before `killJob`'s own status write lands, so an undeclared kill wakes as
   * `exit unknown` and `/jobs` keeps saying `finished` until the marker catches up.
   */
  function declareKill(id: string, kind: KillKind = "killed"): void {
    const job = tracked.get(id);
    if (job) job.killKind = kind;
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
      const elapsed = formatElapsed(elapsedSeconds(v, now));
      return `${v.id}  ${state.label.padEnd(9)}  ${elapsed.padStart(6)}  ${commandLabel(v.command, 60)}`;
    });
  }

  /** An id, or a unique prefix of one: the wake message hands out the full id, so exact is the norm. */
  function findJob(idOrPrefix: string): JobRecord | undefined {
    const jobs = listJobs(dir());
    const exact = jobs.find((job) => job.id === idOrPrefix);
    if (exact) return exact;
    const matches = jobs.filter((job) => job.id.startsWith(idOrPrefix));
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * `all` means every running job this session started, not every running job on the machine: two
   * pi windows in one project are common, and one of them losing a build to the other's cleanup is
   * a surprise nobody can undo.
   */
  async function killAll(ui: ExtensionContext): Promise<void> {
    const sessionId = ui.sessionManager.getSessionId();
    const ids = listJobs(dir())
      .map(view)
      .filter((v) => startedHere(v, sessionId) && jobState(v.status, v.alive).kind === "running")
      .map((v) => v.id);
    if (ids.length === 0) {
      ui.ui.notify("No running jobs from this session to kill", "info");
      return;
    }
    for (const id of ids) {
      declareKill(id);
      const result = await killJob(id, dir());
      const message = result.killed
        ? `Killed ${id}${result.reason ? ` (${result.reason})` : ""}`
        : `${id}: ${result.reason}`;
      ui.ui.notify(message, result.killed ? "info" : "error");
    }
    refreshFooter();
  }

  async function showJobs(ui: ExtensionContext, openId?: string): Promise<void> {
    if (!ui.hasUI) {
      if (openId) {
        const record = findJob(openId);
        if (!record) {
          pi.sendMessage(
            { customType: "jobs-list", content: `No job matches ${openId}.`, display: true },
            { triggerTurn: false },
          );
          return;
        }
        const state = jobState(record.status, isAlive(record.status.pid));
        // 120 lines, not the 2000 a viewer shows: this lands in the transcript, and a long log
        // belongs in the file the last line names.
        const content = [
          `${record.id}  ${state.label}  ${record.paths.dir}`,
          "",
          ...commandBlock(record.command),
          "",
          tailText(readLog(record.paths.log), 120),
          `[Full log: ${record.paths.log}]`,
        ].join("\n");
        pi.sendMessage({ customType: "jobs-list", content, display: true }, { triggerTurn: false });
        return;
      }
      pi.sendMessage(
        { customType: "jobs-list", content: summaryLines().join("\n"), display: true },
        { triggerTurn: false },
      );
      return;
    }

    // Resolve the id (or its unique prefix) once: the overlay only knows exact ids, so a prefix would
    // otherwise read as a job that vanished.
    const requested = openId === undefined ? undefined : findJob(openId);
    if (openId !== undefined && !requested) {
      ui.ui.notify(`No job matches ${openId}.`, "warning");
      return;
    }

    const theme = ui.ui.theme;
    const sessionId = ui.sessionManager.getSessionId();
    const now = (): number => Math.floor(Date.now() / 1000);

    await ui.ui.custom<void>(
      (tui, _theme, kb, done) => {
        let screen: "list" | "output" = requested === undefined ? "list" : "output";
        let scope: JobScope = "project";
        let showFinished = false;
        let index = 0;
        let selectedId: string | undefined = requested?.id;
        let confirm: "none" | "kill" | "clear" = "none";
        let focus: "log" | "command" = "log";
        let follow = true;
        /** Size and mtime of the log the panes were built from, so a quiet job costs one stat. */
        let logSignature = "";
        /** Which job the panes hold, so `/jobs <id>` and a switch both load the right content. */
        let paneJobId: string | undefined;

        const paneTheme = {
          scrollHint: (text: string) => theme.fg("dim", text),
          border: (text: string) => theme.fg("borderMuted", text),
        };
        const commandPane = new ScrollableText([], 3, paneTheme);
        const logPane = new ScrollableText([], 3, paneTheme);

        const height = (): number => panelHeight(tui.terminal.rows);
        const views = (): JobView[] => listJobs(dir()).map(view);
        const rows = (): JobView[] => visibleJobs(views(), { scope, showFinished, cwd: ui.cwd, sessionId });

        /** The list is filtered; the output screen is id-driven, so a finished job still opens. */
        function jobById(id: string | undefined): JobView | undefined {
          if (id === undefined) return undefined;
          return views().find((v) => v.id === id);
        }

        function resolveSelection(all: JobView[]): JobView | undefined {
          if (all.length === 0) {
            selectedId = undefined;
            index = 0;
            return undefined;
          }
          if (selectedId !== undefined) {
            const at = all.findIndex((v) => v.id === selectedId);
            if (at >= 0) {
              index = at;
              return all[at];
            }
          }
          index = Math.max(0, Math.min(all.length - 1, index));
          selectedId = all[index]?.id;
          return all[index];
        }

        function move(delta: number): void {
          const all = rows();
          if (all.length === 0) return;
          index = Math.max(0, Math.min(all.length - 1, index + delta));
          selectedId = all[index]?.id;
          confirm = "none";
          tui.requestRender();
        }

        function openOutput(v: JobView): void {
          selectedId = v.id;
          screen = "output";
          focus = "log";
          confirm = "none";
          follow = jobState(v.status, v.alive).kind === "running";
          paneJobId = v.id;
          commandPane.setLines(commandBlock(v.command));
          commandPane.setScrollOffset(0);
          const paths = jobPaths(dir(), v.id);
          logSignature = `${v.logBytes}:${mtimeSeconds(paths.log) ?? 0}`;
          logPane.setLines(logLines(readLog(paths.log)));
          // Either way the log opens at its end: a failure is read from its last lines, and `home`
          // reaches the start. Only a running job keeps re-pinning to the tail.
          logPane.scrollToEnd();
        }

        /** `/jobs <id>` opens the screen without going through the list, so the panes load on demand. */
        function ensurePanes(v: JobView): void {
          if (paneJobId !== v.id) openOutput(v);
        }

        /** Re-read the log only when it changed; keep the reader's offset unless following. */
        function syncLog(v: JobView): void {
          const paths = jobPaths(dir(), v.id);
          // One guarded stat: another window's clear, or prune, can delete the log between a check and
          // a read, and a throw here happens inside `render` on a 2 Hz path.
          const signature = `${fileSize(paths.log) ?? 0}:${mtimeSeconds(paths.log) ?? 0}`;
          if (signature === logSignature) return;
          logSignature = signature;
          logPane.setLines(logLines(readLog(paths.log)), { keepOffset: true });
          if (follow) logPane.scrollToEnd();
        }

        function notify(message: string, kind: "info" | "warning" | "error" = "info"): void {
          ui.ui.notify(message, kind);
        }

        /** Finished records this session started: the only ones a bulk clear may delete. */
        function clearTargets(all: JobView[] = views()): JobView[] {
          return all.filter((v) => startedHere(v, sessionId) && jobState(v.status, v.alive).kind !== "running");
        }

        function clearRecords(targets: JobView[]): number {
          let removed = 0;
          for (const v of targets) {
            removeJob(dir(), v.id);
            removed++;
          }
          return removed;
        }

        async function copyPane(): Promise<void> {
          const v = jobById(selectedId);
          if (!v) {
            notify("That job is gone", "warning");
            return;
          }
          const record = readJob(dir(), v.id);
          if (!record) {
            notify("That job is gone", "warning");
            return;
          }
          const what = focus === "log" ? "output" : "command";
          const text = focus === "log" ? readLog(record.paths.log) : record.command;
          if (!text.trim()) {
            notify(`No ${what} to copy`, "warning");
            return;
          }
          const result = await copyText(text);
          if (!result.ok) {
            notify(`Copy failed: ${result.reason}`, "error");
            return;
          }
          const cut = focus === "log" && record.logBytes > LOG_READ_LIMIT ? " (last 1 MB)" : "";
          notify(`Copied ${what}${cut}, ${formatBytes(Buffer.byteLength(text, "utf8"))}`);
        }

        async function revealFolder(): Promise<void> {
          // A job's files are its own directory, so the chord follows the selection. With nothing to
          // open (an empty list is the default view's common state) the directory holding every job is
          // still worth opening, and the platform's opener fails on a path that does not exist yet.
          const v = screen === "list" ? resolveSelection(rows()) : jobById(selectedId);
          const own = v === undefined ? undefined : jobPaths(dir(), v.id).dir;
          const target = own !== undefined && fs.existsSync(own) ? own : dir();
          try {
            ensureJobsDir();
          } catch {
            /* the open reports the failure */
          }
          const result = await openFolder(target);
          if (!result.ok) notify(`Could not open the folder: ${result.reason}`, "error");
        }

        function killSelected(): void {
          const v = screen === "list" ? resolveSelection(rows()) : jobById(selectedId);
          if (!v) return;
          if (confirm !== "kill") {
            confirm = "kill";
            tui.requestRender();
            return;
          }
          confirm = "none";
          declareKill(v.id);
          void killJob(v.id, dir()).then((result) => {
            notify(
              result.killed
                ? `Killed ${v.id}${result.reason ? ` (${result.reason})` : ""}`
                : `${v.id}: ${result.reason}`,
              result.killed ? "info" : "error",
            );
            tui.requestRender();
            refreshFooter();
          });
        }

        function clearFinishedRecords(): void {
          const targets = clearTargets();
          if (targets.length === 0) {
            confirm = "none";
            notify("No finished jobs from this session", "info");
            tui.requestRender();
            return;
          }
          if (confirm !== "clear") {
            confirm = "clear";
            tui.requestRender();
            return;
          }
          confirm = "none";
          // Clearing while its output is open would leave the screen on a record that was just deleted.
          const viewing = selectedId;
          const removed = clearRecords(targets);
          notify(`Cleared ${recordCount(removed)}`);
          if (screen === "output" && targets.some((v) => v.id === viewing)) {
            screen = "list";
            paneJobId = undefined;
            follow = false;
            focus = "log";
          }
          selectedId = undefined;
          index = 0;
          tui.requestRender();
          refreshFooter();
        }

        /** The clock column is as wide as the widest `elapsed/budget` on screen, so rows line up. */
        function clockWidth(all: JobView[]): number {
          const nowSeconds = now();
          return Math.max(6, ...all.map((v) => budgetView(v.status, nowSeconds)?.text.length ?? 0));
        }

        /** A budget's level is a theme colour already; `ok` means paint it like the plain clock. */
        function pressureColor(level: BudgetLevel | undefined): "warning" | "error" | undefined {
          return level === "ok" ? undefined : level;
        }

        function listRow(v: JobView, selected: boolean, width: number, clock: number): string {
          const state = jobState(v.status, v.alive);
          const budget = budgetView(v.status, now());
          const elapsed = (budget?.text ?? formatElapsed(elapsedSeconds(v, now()))).padStart(clock);
          const marks: string[] = [];
          if (scope === "all" && v.cwd !== ui.cwd) marks.push(`@${v.cwd?.split("/").pop() || "?"}`);
          if (v.session !== undefined && v.session !== sessionId) marks.push("@other");
          const tail = marks.length > 0 ? `  ${marks.join(" ")}` : "";
          const room = Math.max(10, width - 34 - clock - tail.length);
          const paint = (text: string): string =>
            selected
              ? theme.fg("accent", text)
              : state.kind === "running"
                ? theme.fg("text", text)
                : state.kind === "ok"
                  ? theme.fg("success", text)
                  : state.kind === "failed"
                    ? theme.fg("error", text)
                    : theme.fg("warning", text);
          // The budget keeps its own colour even on the selected row: it is the one number that has to
          // be noticeable at a glance, and `3m50s/4m` inside an accent row says nothing.
          const pressure = pressureColor(budget?.level);
          const clockText = pressure === undefined ? paint(elapsed) : theme.fg(pressure, elapsed);
          const head = `${paint(`${selected ? ">" : " "} ${v.id}  ${state.label.padEnd(9)}`)} ${clockText}  ${paint(commandLabel(v.command, room))}`;
          return `${head}${tail ? paint(tail) : ""}`;
        }

        function titleLine(shownRows: number, totalRows: number, hiddenCount: number): string {
          const parts = [scopeLabel(scope), showFinished ? "running + finished" : "running"];
          const extra = hiddenCount > 0 ? `  ·  ${hiddenCount} finished hidden` : "";
          // A windowed list has to say it is one: nothing on screen hints at the rows it skipped.
          const windowed = totalRows > shownRows ? `  ·  ${shownRows} of ${totalRows}` : "";
          return `${theme.fg("accent", "jobs")}${theme.fg("dim", `  ·  ${parts.join("  ·  ")}${extra}${windowed}`)}`;
        }

        function listHints(all: JobView[], clearable: number): string[] {
          const selected = all[index];
          const first =
            confirm === "kill"
              ? theme.fg("warning", `${keyOf("kill")} again to kill ${selected?.id ?? "this job"}`)
              : confirm === "clear"
                ? theme.fg("warning", `${keyOf("clearFinished")} again to clear ${recordCount(clearable)}`)
                : theme.fg(
                    "dim",
                    `↑↓ select · enter open · ${keyOf("kill")} kill · ${keyOf("clearFinished")} clear finished`,
                  );
          const second = theme.fg(
            "dim",
            `${keyOf("scope")} ${scopeLabel(scope)} · ${keyOf("finished")} ${showFinished ? "hide" : "show"} finished · ${keyOf("copy")} copy · ${keyOf("openFolder")} folder · esc close`,
          );
          return [first, second];
        }

        function renderList(width: number, height: number): string[] {
          // One disk scan per render: the filter, the hidden count and the clear count all read it.
          const all = views();
          const filtered = visibleJobs(all, { scope, showFinished, cwd: ui.cwd, sessionId });
          resolveSelection(filtered);
          const window = windowRows(filtered.length, index, listBodyHeight(height));
          const shown = filtered.slice(window.start, window.end);
          const clock = clockWidth(shown);
          const lines =
            filtered.length === 0
              ? [theme.fg("muted", showFinished ? "No jobs here." : "No running jobs.")]
              : shown.map((v, offset) => listRow(v, window.start + offset === index, width, clock));
          const hiddenCount = showFinished ? 0 : hiddenFinished(all, { scope, cwd: ui.cwd, sessionId });
          return [
            titleLine(shown.length, filtered.length, hiddenCount),
            "",
            ...lines,
            ...listHints(filtered, clearTargets(all).length),
          ];
        }

        function outputHints(): string {
          // An armed kill or clear has to say so here: this screen has no other place to show state.
          if (confirm === "kill")
            return theme.fg("warning", `${keyOf("kill")} again to kill ${selectedId ?? "this job"}`);
          if (confirm === "clear") {
            return theme.fg(
              "warning",
              `${keyOf("clearFinished")} again to clear ${recordCount(clearTargets().length)}`,
            );
          }
          const what = focus === "log" ? "output" : "command";
          const parts = [
            ...(focus === "log" && follow ? ["following"] : ["↑↓ scroll"]),
            `tab ${focus === "log" ? "command" : "output"}`,
            `${keyOf("copy")} copy ${what}`,
            `${keyOf("kill")} kill`,
            `${keyOf("clearFinished")} clear`,
            `${keyOf("openFolder")} folder`,
            "esc back",
          ];
          return theme.fg("dim", parts.join(" · "));
        }

        function renderOutput(width: number, height: number): string[] {
          const v = jobById(selectedId);
          if (!v) return [theme.fg("muted", "That job is gone."), "", theme.fg("dim", "esc back")];
          ensurePanes(v);
          syncLog(v);
          const split = splitOutput(height, commandBlock(v.command).length);
          commandPane.setMaxHeight(split.command);
          logPane.setMaxHeight(split.log);
          const state = jobState(v.status, v.alive);
          const budget = budgetView(v.status, now());
          const elapsed = budget?.text ?? formatElapsed(elapsedSeconds(v, now()));
          const pressure = pressureColor(budget?.level);
          const other = v.session !== undefined && v.session !== sessionId ? "  @other" : "";
          const header = `${theme.fg("accent", `${v.id}  ${state.label}  `)}${pressure === undefined ? theme.fg("accent", elapsed) : theme.fg(pressure, elapsed)}${theme.fg("accent", other)}`;
          const command = commandPane
            .render(width)
            .map((line) => theme.fg(focus === "command" ? "text" : "muted", line));
          return [header, ...command, "", ...logPane.render(width), outputHints()];
        }

        const refresh = setInterval(() => {
          const v = screen === "output" ? jobById(selectedId) : undefined;
          if (v) syncLog(v);
          tui.requestRender();
        }, 500);
        refresh.unref?.();

        return {
          render(width: number): string[] {
            const lines = screen === "list" ? renderList(width, height()) : renderOutput(width, height());
            // The frame comes out of `DIALOG_RULE_ROWS` here, so the constant and the render cannot drift.
            const rule = theme.fg("borderMuted", "─".repeat(width));
            const framed = [...Array.from({ length: DIALOG_RULE_ROWS }, () => rule), ...lines];
            return framed.map((line) => truncateToWidth(line, width));
          },
          invalidate() {
            commandPane.invalidate();
            logPane.invalidate();
          },
          handleInput(data: string): void {
            if (screen === "list") {
              const all = rows();
              if (kb.matches(data, "tui.select.up")) {
                move(-1);
                return;
              }
              if (kb.matches(data, "tui.select.down")) {
                move(1);
                return;
              }
              if (kb.matches(data, "tui.select.pageUp")) {
                move(-listBodyHeight(height()));
                return;
              }
              if (kb.matches(data, "tui.select.pageDown")) {
                move(listBodyHeight(height()));
                return;
              }
              if (kb.matches(data, "tui.select.confirm")) {
                const v = resolveSelection(all);
                if (v) openOutput(v);
                tui.requestRender();
                return;
              }
              // Any key other than the chord that armed it cancels a pending kill or clear, which is
              // what the hint line promises. Placed before the handlers because most of them return.
              if (!matchesKey(data, JOB_SHORTCUTS.kill) && !matchesKey(data, JOB_SHORTCUTS.clearFinished)) {
                confirm = "none";
              }
              if (matchesKey(data, JOB_SHORTCUTS.kill)) {
                killSelected();
                return;
              }
              if (matchesKey(data, JOB_SHORTCUTS.clearFinished)) {
                clearFinishedRecords();
                return;
              }
              if (matchesKey(data, JOB_SHORTCUTS.finished)) {
                showFinished = !showFinished;
                confirm = "none";
                selectedId = undefined;
                index = 0;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, JOB_SHORTCUTS.scope)) {
                scope = cycleScope(scope);
                confirm = "none";
                selectedId = undefined;
                index = 0;
                tui.requestRender();
                return;
              }
              if (matchesKey(data, JOB_SHORTCUTS.copy)) {
                void copyPane();
                return;
              }
              if (matchesKey(data, JOB_SHORTCUTS.openFolder)) {
                void revealFolder();
                return;
              }
              if (kb.matches(data, "tui.select.cancel")) {
                done();
                return;
              }
              confirm = "none";
              tui.requestRender();
              return;
            }

            const v = jobById(selectedId);
            if (kb.matches(data, "tui.select.cancel")) {
              screen = "list";
              follow = false;
              confirm = "none";
              // The list has no focus, and its copy reports the job's output, so the panes' focus must not
              // leak back with it.
              focus = "log";
              tui.requestRender();
              return;
            }
            // Same rule as the list: anything but the arming chord cancels, Tab and copy included.
            if (!matchesKey(data, JOB_SHORTCUTS.kill) && !matchesKey(data, JOB_SHORTCUTS.clearFinished)) {
              confirm = "none";
            }
            if (matchesKey(data, "tab")) {
              focus = focus === "log" ? "command" : "log";
              tui.requestRender();
              return;
            }
            if (matchesKey(data, JOB_SHORTCUTS.kill)) {
              killSelected();
              return;
            }
            if (matchesKey(data, JOB_SHORTCUTS.clearFinished)) {
              clearFinishedRecords();
              return;
            }
            if (matchesKey(data, JOB_SHORTCUTS.copy)) {
              void copyPane();
              return;
            }
            if (matchesKey(data, JOB_SHORTCUTS.openFolder)) {
              void revealFolder();
              return;
            }
            if (!v) return;
            // The follow state is decided by the key, not by whether the pane moved: `end` on a log
            // already at its bottom moves nothing and still means "follow again".
            if (focus === "log") {
              if (matchesKey(data, "end")) follow = true;
              else if (
                matchesKey(data, "up") ||
                matchesKey(data, "pageUp") ||
                matchesKey(data, "shift+up") ||
                matchesKey(data, "home")
              )
                follow = false;
            }
            const pane = focus === "log" ? logPane : commandPane;
            pane.handleInput(data);
            tui.requestRender();
          },
          handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
            if (screen === "list") {
              if (event.type !== "wheel" || !event.wheelDelta) return undefined;
              move(event.wheelDelta < 0 ? -1 : 1);
              return { handled: true };
            }
            if (event.type !== "wheel" || !event.wheelDelta) return undefined;
            // The wheel scrolls the focused pane, not the pane under the cursor. Routing by row would mean a
            // boundary derived from the render (rule, header, then the split) that no test in this tree can
            // pin, and `ScrollableText` ignores `y` anyway: the routing would only choose a pane, which `tab`
            // already does.
            const pane = focus === "log" ? logPane : commandPane;
            const forwarded = pane.handleMouse(event);
            // Only a wheel that actually moved the log stops it following; `end` is what re-attaches.
            if (pane === logPane && forwarded?.render === true && event.wheelDelta < 0) follow = false;
            if (forwarded?.render !== false) tui.requestRender();
            return forwarded ?? { handled: true };
          },
          dispose: () => clearInterval(refresh),
        };
      },
      // Full width: the renderer composites the overlay over the transcript, so a narrower rectangle leaves a
      // strip of chat text down each side, at the same rows as the list, which reads as if it belonged here.
      // Flush to the bottom edge: an overlay is placed by its anchor, and the center anchor left this one
      // floating mid-transcript with dead rows under it. The dock's height is not readable from an extension,
      // so any placement that keeps the footer visible would be a guess; the panel takes the bottom instead,
      // and the rule at the top of the render is what gives it an edge.
      { overlay: true, overlayOptions: () => ({ width: "100%", margin: 0, anchor: "bottom-center" }) },
    );
    refreshFooter();
  }

  pi.registerCommand("jobs", {
    description: "Background jobs: /jobs [id], /jobs kill <id|all>",
    handler: async (args, ui) => {
      ctx = ui;
      const trimmed = args.trim();
      if (trimmed.startsWith("kill")) {
        const target = trimmed.slice("kill".length).trim();
        if (!target) {
          ui.ui.notify("Usage: /jobs kill <id|all>", "warning");
          return;
        }
        if (target === "all") await killAll(ui);
        else {
          declareKill(target);
          const result = await killJob(target, dir());
          ui.ui.notify(
            result.killed
              ? `Killed ${target}${result.reason ? ` (${result.reason})` : ""}`
              : `${target}: ${result.reason}`,
            result.killed ? "info" : "error",
          );
          refreshFooter();
        }
        return;
      }
      await showJobs(ui, trimmed || undefined);
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
