/**
 * Notifications when the agent finishes, or when it starts waiting on a
 * decision.
 *
 * Both triggers are first-class pi events:
 * - `agent_settled`: the run is over and no retry, compaction, steering or
 *   queued message will continue it. `agent_end` is not that signal.
 * - `ui_prompt_start`: some extension opened a blocking dialog. pi reports this
 *   for every dialog kind, `custom()` included, so a dialog added later needs no
 *   cooperation from this extension.
 *
 * Two transports and a local cue, gated differently: the terminal frame is local
 * and always written; a push leaves the machine (ntfy.sh by default, where anyone
 * holding the topic can read it) and only fires when nobody is at the keyboard; a
 * cue plays locally when the user is away, at a lower idle threshold and with no
 * minimum run, and carries the project and which event fired rather than the
 * run's facts. See `idle.ts` for that rule, `format.ts` for what the frame and the
 * push carry, and `sound.ts` for the cue.
 *
 * The interactive UI only: an rpc client renders those dialogs itself, and a
 * terminal frame written into its stdout would corrupt the JSON-RPC stream.
 * Print and json runs have no UI to write to.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AnswerFacts,
  blockedNote,
  blockedPushBody,
  describeToolCall,
  lastAnswer,
  type Note,
  type RunFacts,
  type SettledContext,
  settledNote,
  settledPushBody,
} from "./format";
import { away, hidIdleSeconds, pushBlocked, pushSettled, readPolicy } from "./idle";
import { push, resolveNtfyUrl } from "./ntfy";
import { noFrameReason, notificationBytes, parseTmuxProgram } from "./osc";
import { type CueKind, playCue, playCueAndWait, soundEnabled, soundIdleSeconds } from "./sound";

type RunState = RunFacts & AnswerFacts;

const CUE_KINDS: CueKind[] = ["done", "needsyou"];

function off(env: NodeJS.ProcessEnv): boolean {
  return env.PI_NOTIFY_OFF === "1";
}

function configFile(env: NodeJS.ProcessEnv): string {
  return env.PI_NOTIFY_NTFY_FILE ?? `${homedir()}/.config/llm/notify-ntfy-url`;
}

function pushUrl(env: NodeJS.ProcessEnv): string | undefined {
  return resolveNtfyUrl(env.PI_NOTIFY_NTFY_URL, configFile(env));
}

/** The terminal behind tmux, which a pane's own environment cannot name. */
function outerProgram(env: NodeJS.ProcessEnv): string | null {
  if (!env.TMUX) return null;
  try {
    return parseTmuxProgram(
      execFileSync("tmux", ["show-environment", "-g", "TERM_PROGRAM"], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

export default function notify(pi: ExtensionAPI) {
  const policy = readPolicy(process.env);
  // A cue is gated lower than a push, and has no minimum run: it costs a sound,
  // not a buzz on a phone.
  const cuePolicy = { idleSeconds: soundIdleSeconds(process.env) };
  const cues = soundEnabled(process.env);
  const terminal = off(process.env) ? null : outerProgram(process.env);
  let run: RunState | null = null;
  let warned = false;

  /** Null when the frame was written, otherwise why it was not. */
  function writeFrame(note: Note): string | null {
    const bytes = notificationBytes(process.env, note.title, note.body, terminal);
    if (bytes) {
      process.stdout.write(bytes);
      return null;
    }
    return noFrameReason(process.env.PI_NOTIFY_PROTOCOL);
  }

  /**
   * Play a project cue once the user is away. Never blocks and never throws: the
   * idle probe runs in the background, and a cue that cannot be written or played
   * is simply absent.
   */
  function playWhenAway(project: string, kind: CueKind, idle: () => Promise<number | null>): void {
    void idle()
      .then((seconds) => {
        if (away(seconds, cuePolicy)) playCue(project, kind);
      })
      .catch(() => undefined);
  }

  /** The `ioreg` probe, started on first use and shared by both gates. */
  function idleProbe(): () => Promise<number | null> {
    let pending: Promise<number | null> | null = null;
    return () => (pending ??= hidIdleSeconds());
  }

  /** Never rejects and never blocks a run: a push is best effort. */
  async function sendPush(
    ctx: ExtensionContext,
    url: string,
    title: string,
    body: string,
    priority: "default" | "high",
  ): Promise<void> {
    try {
      const result = await push(url, { title, body, priority, tags: priority === "high" ? "bell" : "robot" });
      if (!result.sent && !warned) {
        warned = true;
        ctx.ui.notify(`notify: push failed: ${result.reason}`, "warning");
      }
    } catch {
      // Nothing to report to: the reason this path exists is that the user is away.
    }
  }

  pi.on("agent_start", () => {
    // A retry, overflow recovery or queued message continues the run through
    // another agent_start; the run's start and counters must survive it, or a
    // long run reports its last segment and misses the min-run push gate.
    run ??= { startedAt: Date.now(), toolCalls: 0 };
  });

  pi.on("tool_call", (event) => {
    if (!run) return;
    run.toolCalls += 1;
    const label = describeToolCall(event.toolName, event.input);
    if (label) run.lastAction = label;
  });

  pi.on("tool_result", (event) => {
    if (!run) return;
    // Only the last tool result counts: a command that failed and was then fixed
    // must not settle as a failed run.
    run.lastToolError = event.isError ? event.toolName : undefined;
  });

  pi.on("agent_end", (event) => {
    if (!run) return;
    const answer = lastAnswer(event.messages);
    run.snippet = answer.snippet;
    run.truncated = answer.truncated;
  });

  // The push helpers are called as `void`: never rejects and never blocks the
  // caller. The idle probe waits on a subprocess, and pi awaits the settled event
  // before the session goes idle, so nothing here may add a throw or an await at
  // a call site. The caller probes idle once and hands the promise to both gates,
  // but only when a cue or a topic makes the answer matter.
  async function pushSettledNote(
    ctx: ExtensionContext,
    url: string,
    facts: RunFacts,
    context: SettledContext,
    idle: () => Promise<number | null>,
  ): Promise<void> {
    if (context.now - facts.startedAt < policy.minRunMs) return;
    if (!pushSettled(context.now - facts.startedAt, await idle(), policy)) return;
    await sendPush(ctx, url, "pi done", settledPushBody(facts, context), "default");
  }

  async function pushBlockedNote(
    ctx: ExtensionContext,
    url: string,
    context: { project: string },
    kind: string,
    idle: () => Promise<number | null>,
  ): Promise<void> {
    if (!pushBlocked(await idle(), policy)) return;
    await sendPush(ctx, url, "pi needs you", blockedPushBody(context, kind), "high");
  }

  pi.on("agent_settled", (event, ctx) => {
    const facts = run;
    run = null;
    // A run the user ended with Escape is a decision, not news.
    if (off(process.env) || ctx.mode !== "tui" || !facts || event.aborted) return;
    const context = {
      project: basename(ctx.cwd),
      session: pi.getSessionName(),
      now: Date.now(),
      snippet: facts.snippet,
    };
    writeFrame(settledNote(facts, context));
    const url = pushUrl(process.env);
    if (!url && !cues) return;
    // One probe per event, shared by both gates. The push helper calls it after
    // its min-run gate; a cue needs it up front, since the away gate is what
    // decides whether the cue plays at all.
    const idle = idleProbe();
    if (cues) playWhenAway(context.project, "done", idle);
    if (url) void pushSettledNote(ctx, url, facts, context, idle);
  });

  pi.on("ui_prompt_start", (event, ctx) => {
    if (off(process.env) || ctx.mode !== "tui") return;
    const context = { project: basename(ctx.cwd) };
    writeFrame(blockedNote({ kind: event.kind, title: event.title }, context));
    const url = pushUrl(process.env);
    if (!url && !cues) return;
    const idle = idleProbe();
    if (cues) playWhenAway(context.project, "needsyou", idle);
    if (url) void pushBlockedNote(ctx, url, context, event.kind, idle);
  });

  pi.registerCommand("notify", {
    description: "Send a test notification through the terminal frame, the cues and the push channel",
    handler: async (_args, ctx) => {
      if (off(process.env) || ctx.mode !== "tui") {
        ctx.ui.notify("notify: disabled, or outside the interactive UI", "info");
        return;
      }
      const project = basename(ctx.cwd);
      const frame =
        writeFrame({ title: "pi notify test", body: `${project}, terminal frame` }) ?? "terminal frame written";
      // Awaited one at a time: the fire-and-forget player returns immediately, so
      // looping through both would mix the two shapes instead of comparing them.
      const sound: string[] = [];
      if (cues) {
        for (const kind of CUE_KINDS) {
          const result = await playCueAndWait(project, kind);
          sound.push(`${kind} ${result.played ? "played" : result.reason}`);
        }
      }
      const sounds = sound.length > 0 ? sound.join(", ") : "disabled";
      const url = pushUrl(process.env);
      if (!url) {
        ctx.ui.notify(`notify: ${frame}; sounds: ${sounds}; no push URL configured`, "info");
        return;
      }
      const result = await push(url, { title: "pi notify test", body: `${project}, push` });
      ctx.ui.notify(
        result.sent
          ? `notify: ${frame}; sounds: ${sounds}; push sent`
          : `notify: ${frame}; sounds: ${sounds}; push failed: ${result.reason}`,
        result.sent ? "info" : "warning",
      );
    },
  });
}
