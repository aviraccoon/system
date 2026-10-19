/**
 * RPC-based subagent execution.
 *
 * Spawns `pi --mode rpc` and communicates via bidirectional JSONL.
 * Handles streaming state, tool call tracking, steering, and abort.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionContext, type ThemeColor, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createDebugLogger } from "../shared/debug";
import { loadConfig, parseRef, resolveRoleChain, type ThinkingLevel } from "../shared/model-roles";
import { BASH_SANDBOX_ENV, SANDBOX_COMMAND_ENV } from "../shared/sandbox";
import type { AgentConfig } from "./agents";
import { type AttemptOutcome, attemptPlan, isRetryable, MAX_ATTEMPTS } from "./retry";
import { type AgentTargets, type AttemptTarget, DEFAULT_SUBAGENT_ROLE, planAgentTargets, targetArgs } from "./target";
import { type NudgeState, steerNudge, taskWithBudget } from "./turn-budget";

const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "subagent-sessions");
const debugLog = createDebugLogger("subagent");

// ── Subagent execution ──

/**
 * Resolve an agent's model targets, in fallback order: a pinned `model` needs no
 * roles.json at all, otherwise the declared `role` — or the default `subagent` role —
 * resolves through roles.json. `planAgentTargets` holds the precedence rules.
 */
export async function resolveAgentTargets(agent: AgentConfig, ctx: ExtensionContext): Promise<AgentTargets> {
  if (agent.model) {
    // The role path filters its refs through `resolveRoleChain`; a pinned ref needs the
    // same check, or a stale one costs three failed spawns and reads as a retry.
    const parsed = parseRef(agent.model);
    const model = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.modelId) : undefined;
    if (!model) {
      return {
        targets: [],
        error: `Agent "${agent.name}" pins model "${agent.model}", which is not in the model catalog (expected provider/model-id).`,
      };
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return {
        targets: [],
        error: `Agent "${agent.name}" pins model "${agent.model}", but provider "${parsed?.provider ?? agent.model}" has no credentials.`,
      };
    }
    return planAgentTargets(agent, []);
  }

  const chain = (await resolveRoleChain(agent.role ?? DEFAULT_SUBAGENT_ROLE, ctx.modelRegistry, MAX_ATTEMPTS)).map(
    (resolved) => ({
      ref: `${resolved.model.provider}/${resolved.model.id}`,
      thinking: resolved.thinking,
    }),
  );
  return planAgentTargets(agent, chain);
}

/** Get available roles from roles.json (uses shared module for merging). */
export function getAvailableRoles(): string[] {
  const roles = loadConfig();
  return Object.keys(roles).filter((name) => roles[name]?.models?.length > 0);
}

/** Get the primary model for a role (first in the chain). */
export function getRolePrimaryModel(roleName: string): string | null {
  const roles = loadConfig();
  const roleConfig = roles[roleName];
  return roleConfig?.models?.[0]?.ref || null;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** Zeroed usage for a result that never spawned a child. */
function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** A user steering message sent mid-run, positioned at the completed-turn count when it arrived. */
export interface UserInput {
  text: string;
  /** Completed turns at steer time (turn_end count). Displayed before turn+1. */
  turn: number;
}

export interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "notes" | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  userInputs?: UserInput[];
  /** Path to the child's transcript, so the caller can read what a run actually did. */
  sessionFile?: string;
  /** Child process id; the spawn line in this pi process's debug log records it, tying the result to a live process. */
  pid?: number;
  role?: string; // role name used for model resolution
  model?: string; // resolved model ref
  /** Thinking level passed to the child; unset when pi's own default applies. */
  thinking?: ThinkingLevel;
  stopReason?: string;
  errorMessage?: string;
  /** Models tried before this result returned (1 = no retry). */
  attempts?: number;
  step?: number;
}

/** Handle for steering a running RPC subagent. */
export interface SubagentHandle {
  /** Send a steering message to the running subagent. Delivered after current tool batch. */
  steer(message: string): Promise<void>;
  /** Check if the subagent is currently streaming. */
  isStreaming(): boolean;
  /** Abort the subagent. */
  abort(): void;
}

export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  agentScope: "user" | "project" | "both";
  results: SingleResult[];
  /** Set on a streaming update so the live view can name the target that is running. */
  live?: LiveTarget;
}

/** What a running child was started with. The live view has no result yet, so it
 * cannot read this off `SingleResult`. */
export interface LiveTarget {
  agent: string;
  source: SingleResult["agentSource"];
  /** Resolved model ref, unset when the child runs pi's own default model. */
  model?: string;
  role?: string;
  thinking?: ThinkingLevel;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/** One line of usage counters. The model and its level are the header's job
 * (`targetLabel`), so they are not repeated here. */
export function formatUsageStats(usage: UsageStats): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

/**
 * Text of the newest assistant message's own parts, skipping trailing tool
 * results a retry may have appended. Unlike getFinalOutput this does not walk
 * back to earlier messages: narration from a previous turn is not the answer to
 * the run that stopped without one.
 */
export function finalAnswerText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    return msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

/** A run that did not deliver an answer: spawn failure, a stop whose final
 * message carries no text, an abort, or the turn budget. An errored stream that
 * still produced the answer counts as delivered — the report is the product. */
export function resultFailed(r: SingleResult): boolean {
  if (r.exitCode === -1) return false; // still running
  if (r.exitCode !== 0) return true;
  if (r.stopReason === "aborted" || r.stopReason === "max_turns_exceeded") return true;
  return finalAnswerText(r.messages).trim() === "";
}

/**
 * Messages to keep after an agent_end. Each batch is one run's own messages, so an
 * in-place retry that produced no answer must not wipe the answer an earlier
 * attempt delivered: the answer is the product, whatever the next attempt did.
 */
export function mergeAttemptMessages(current: Message[], incoming: Message[]): Message[] {
  if (incoming.length === 0) return current;
  if (finalAnswerText(incoming).trim() !== "") return incoming;
  if (finalAnswerText(current).trim() !== "") return current;
  return incoming;
}

/**
 * A run that produced its answer and then lost the stream: delivered, but the text
 * may be cut off. Keyed on the stop reason, not the message — a provider can report
 * an error with no words of its own.
 */
export function deliveredStreamError(r: SingleResult): boolean {
  return !resultFailed(r) && r.stopReason === "error";
}

/** The words for a delivered stream error, with a stand-in when the provider gave none. */
export function streamErrorReason(r: SingleResult): string {
  return r.errorMessage || "the provider reported an error";
}

/**
 * Suffix for a delivered answer whose stream errored at the end: the text is the
 * product and stays, but the consumer has to be able to tell it may be truncated.
 * Empty for every other result.
 */
export function streamErrorSuffix(r: SingleResult): string {
  if (!deliveredStreamError(r)) return "";
  return `\n\n[stream ended early: ${streamErrorReason(r)} — the answer above may be truncated]`;
}

/**
 * One line per chain step whose stream ended early, naming the step and the reason.
 * The chain still completes; the caller reads this to know which handoffs were cut.
 */
export function chainStreamWarning(results: readonly SingleResult[]): string {
  return results
    .map((r, i) =>
      deliveredStreamError(r) ? `[step ${i + 1} (${r.agent}) stream ended early: ${streamErrorReason(r)}]` : "",
    )
    .filter((line) => line !== "")
    .join("\n");
}

/** A block of text with a delivered stream warning appended under it. */
export function withStreamWarning(text: string, r: SingleResult): string {
  return `${text}${streamErrorSuffix(r)}`;
}

/** A block of text with the per-step stream warnings appended under it. */
export function withChainWarnings(text: string, results: readonly SingleResult[]): string {
  const warnings = chainStreamWarning(results);
  return warnings ? `${text}\n\n${warnings}` : text;
}

/** Attempt outcome for the retry policy. */
export function attemptOutcome(result: SingleResult): AttemptOutcome {
  return {
    stopReason: result.stopReason,
    exitCode: result.exitCode,
    messageCount: result.messages.length,
    outputEmpty: finalAnswerText(result.messages).trim() === "",
  };
}

export type DisplayItem =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export interface DisplayTurn {
  /** 1-based turn number (one per assistant message). */
  turn: number;
  items: DisplayItem[];
}

/** Group assistant messages into turns, preserving thinking/text/toolCall parts. */
export function getDisplayTurns(messages: Message[]): DisplayTurn[] {
  const turns: DisplayTurn[] = [];
  let turn = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    turn++;
    const items: DisplayItem[] = [];
    for (const part of msg.content) {
      if (part.type === "text" && part.text) items.push({ type: "text", text: part.text });
      else if (part.type === "thinking" && part.thinking) items.push({ type: "thinking", text: part.thinking });
      else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
    }
    turns.push({ turn, items });
  }
  return turns;
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string,
): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      // Full command — continuation lines indented so multi-line commands stay readable.
      const display = command.replace(/\n/g, "\n  ");
      return themeFg("muted", "$ ") + themeFg("toolOutput", display);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      return themeFg("muted", "read ") + themeFg("accent", filePath);
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "patch": {
      const top = (args.file_path || args.path) as string | undefined;
      const edits = Array.isArray(args.edits) ? (args.edits as Array<{ path?: string }>) : [];
      const paths = [
        ...(top ? [top] : []),
        ...edits.map((e) => e.path).filter((p): p is string => typeof p === "string"),
      ];
      const shown = paths.length > 0 ? paths.map(shortenPath).join(", ") : "...";
      const count = edits.length > 1 ? themeFg("dim", ` (${edits.length} edits)`) : "";
      return themeFg("muted", "patch ") + themeFg("accent", shown) + count;
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      // Unknown tool — show the full args; the tool name is the label, args are the payload.
      return themeFg("accent", toolName) + themeFg("dim", ` ${JSON.stringify(args)}`);
    }
  }
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * RPC-based subagent execution with steering support.
 *
 * Spawns `pi --mode rpc --no-session` and communicates via bidirectional
 * JSONL over stdin/stdout. Supports mid-run steering via the `steer()`
 * command. Events are parsed from stdout; commands are written to stdin.
 */
interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

interface RpcCommand {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export function writeRpcCommand(proc: ReturnType<typeof spawn>, cmd: RpcCommand): void {
  const stdin = proc.stdin;
  if (!stdin) return;
  stdin.write(`${JSON.stringify(cmd)}\n`);
}

/**
 * Run a subagent, retrying provider failures across the agent's role chain.
 * Up to MAX_ATTEMPTS models are tried — the chain's next entries, padded with
 * the last one — and the first result that is not a provider failure wins.
 */
export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { content: unknown[]; details?: SubagentDetails }) => void) | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  ctx: ExtensionContext,
  maxTurns: number,
  onHandle?: (handle: SubagentHandle) => (() => void) | undefined,
): Promise<SingleResult> {
  // Cleared once per dispatch, not per attempt, so retries stay in the log.
  debugLog.clear();

  const agent = agents.find((a) => a.name === agentName);
  // Resolution happens once, and the attempt runs the target it is handed, so a
  // retry's level is the level of the model that attempt actually runs.
  const resolved: AgentTargets = agent ? await resolveAgentTargets(agent, ctx) : { targets: [] };
  const plan = attemptPlan(resolved.targets);

  // Handles are per attempt: drop the previous registration before the next
  // one, or the active-handle list keeps a dead child per retry.
  let cleanupHandle: (() => void) | undefined;
  const handleSink = onHandle
    ? (handle: SubagentHandle): (() => void) | undefined => {
        cleanupHandle?.();
        cleanupHandle = onHandle(handle) || undefined;
        return cleanupHandle;
      }
    : undefined;

  const runAttempt = (target?: AttemptTarget) =>
    runSingleAgentAttempt(
      defaultCwd,
      agents,
      agentName,
      task,
      cwd,
      step,
      signal,
      onUpdate,
      makeDetails,
      ctx,
      maxTurns,
      handleSink,
      target,
      resolved,
    );

  // No targets (no role, an absent default role, or a resolution error): one attempt,
  // so the unknown-agent and config errors still come from the attempt.
  if (plan.length === 0) {
    const only = await runAttempt();
    only.attempts = 1;
    cleanupHandle?.();
    return only;
  }

  let result: SingleResult | undefined;
  for (const [i, target] of plan.entries()) {
    result = await runAttempt(target);
    result.attempts = i + 1;
    if (!isRetryable(attemptOutcome(result))) {
      break;
    }
    debugLog("retry", 0, {
      agent: agentName,
      failed: target.ref,
      next: plan[i + 1]?.ref ?? null,
      stopReason: result.stopReason,
    });
  }
  cleanupHandle?.();
  return result as SingleResult;
}

/**
 * Whether this agent_end is followed by pi's own in-place retry (the failed turn
 * is omitted from context and the run continues in the same session). Only an
 * explicit `true` counts: a child that does not report the field is finished.
 */
export function childRetryPending(event: Record<string, unknown>): boolean {
  return event.willRetry === true;
}

/**
 * Stop reason after the child process closes. A turn-capped run reports
 * max_turns_exceeded unless the abort raced a natural agent_end with
 * stopReason "stop"; a user abort marks "aborted" only when it landed before
 * agent_end completed — after agent_end the abort is cleanup, not the outcome.
 * The returned reason replaces the run's own stop reason when defined.
 */
export function exitStopReason(
  maxTurnsReached: boolean,
  wasAborted: boolean,
  agentEndReceived: boolean,
  stopReason: string | undefined,
): string | undefined {
  if (maxTurnsReached) {
    return stopReason === "stop" ? stopReason : "max_turns_exceeded";
  }
  if (wasAborted && !agentEndReceived) return "aborted";
  return stopReason;
}

/** One attempt: spawn the child, stream its events, collect the result. */
async function runSingleAgentAttempt(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { content: unknown[]; details?: SubagentDetails }) => void) | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  ctx: ExtensionContext,
  maxTurns: number,
  onHandle?: ((handle: SubagentHandle) => void) | undefined,
  target?: AttemptTarget,
  resolved: AgentTargets = { targets: [] },
): Promise<SingleResult> {
  const agent = agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      step,
    };
  }

  // A config error (a named role with no available models, an invalid thinking
  // level) is reported instead of spawning, so the fix is one edit away.
  if (resolved.error) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: resolved.error,
      usage: emptyUsage(),
      role: resolved.role,
      // A pinned-model error has no role: name the ref it failed on, so the header
      // says what was rejected instead of leaving the reason in stderr only.
      model: agent.model,
      step,
    };
  }

  // The retry wrapper hands each attempt its own target; without one (no role, an
  // absent default role) the child runs pi's default model at pi's default level.
  const role = resolved.role;
  const model = target?.ref;

  // Session dir for subagent runs — keeps session files separate from main sessions.
  // Useful for debugging what subagents actually did (tool calls, messages, etc.).
  try {
    fs.mkdirSync(SUBAGENT_SESSION_DIR, { recursive: true });
  } catch {}

  // RPC mode: bidirectional JSONL over stdin/stdout
  const args: string[] = ["--mode", "rpc", "--session-dir", SUBAGENT_SESSION_DIR];
  // The level rides each attempt: a chain entry's own level, or the agent's override.
  if (target) args.push(...targetArgs(target));

  // Tool allowlist (built-in tools)
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  // Extension loading: --no-extensions disables auto-discovery, then load
  // only the extensions we explicitly select.
  //
  // Default extensions for all subagents:
  //   agents-loader — provides AGENTS.local.md context, lightweight
  //   permission-gate — gates tool calls; in no-UI mode it auto-allows SAFE
  //                     (auto-classify mode) or silently blocks (careful mode).
  //                     Useful as a safety net even without UI.
  //
  // Agent-specific extensions come from the `extensions` frontmatter field.
  args.push("--no-extensions");

  const defaultSubagentExtensions = ["agents-loader", "permission-gate"];
  const agentExtensions = agent.extensions ?? [];
  const allExtensions = [...new Set([...defaultSubagentExtensions, ...agentExtensions])];

  // Resolve extension names: check ~/.pi/agent/extensions/<name>/ first,
  // then treat as relative/absolute path
  const agentExtDir = path.join(os.homedir(), ".pi", "agent", "extensions");
  for (const ext of allExtensions) {
    let resolved: string | null = null;
    if (path.isAbsolute(ext)) {
      resolved = ext;
    } else {
      const asName = path.join(agentExtDir, ext);
      if (fs.existsSync(asName)) {
        resolved = asName;
      } else if (fs.existsSync(`${asName}.ts`)) {
        resolved = `${asName}.ts`;
      } else {
        const asDir = path.join(agentExtDir, ext, "index.ts");
        if (fs.existsSync(asDir)) {
          resolved = path.join(agentExtDir, ext);
        }
      }
      if (!resolved) {
        resolved = path.join(defaultCwd, ext);
      }
    }
    if (fs.existsSync(resolved)) {
      args.push("--extension", resolved);
    }
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    userInputs: [],
    role,
    model,
    thinking: target?.thinking,
    step,
  };

  // A missing cwd fails node's spawn with ENOENT that names the command, not the
  // directory — fail here instead, naming the actual problem.
  const effectiveCwd = cwd ?? defaultCwd;
  if (!fs.existsSync(effectiveCwd)) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      exitCode: 1,
      messages: [],
      stderr: `cwd does not exist: ${effectiveCwd}`,
      usage: emptyUsage(),
      step,
    };
  }

  // RPC state tracking
  let isStreaming = false;
  // Ordered log of everything the subagent produced (thinking, text, tool calls) —
  // rebuilt into content on every update. Exact order, no length-based interleaving.
  const streamEvents: Array<
    | { kind: "thinking"; text: string }
    | { kind: "text"; text: string }
    | { kind: "toolCall"; name: string; args: Record<string, unknown> }
    | { kind: "user"; text: string }
  > = [];
  let wasAborted = false;
  let agentEndReceived = false; // tracks whether agent_end fired (normal completion)
  let eventCount = 0;
  let updateCount = 0; // how many times emitUpdate was called
  let turnCount = 0; // completed turns (turn_end events) — drives the maxTurns cap
  const nudgeState: NudgeState = { sent: false }; // the budget nudge is one-shot per attempt
  let maxTurnsReached = false; // child was aborted at the turn cap
  let sentSessionQuery = false; // asked the child for its transcript path

  // ── Extension UI relay ──
  // Subagent's ctx.ui.confirm()/select()/input() emit extension_ui_request events on stdout.
  // We relay them to the parent's TUI via ctx.ui, then send the response back on stdin.
  //
  // The Promise resolves synchronously when the response arrives, which unblocks the event
  // loop (the await yields to the microtask). The event loop then continues processing stdin
  // events normally. See: https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-pending-tasks
  const pendingDialogs = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const DIALOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  const cleanup = () => {
    for (const { timer } of pendingDialogs.values()) clearTimeout(timer);
    pendingDialogs.clear();
  };
  // Track how many tool calls have been sent, for incremental updates
  const emitUpdate = () => {
    if (onUpdate) {
      updateCount++;
      const streamText = streamEvents
        .filter((e) => e.kind !== "toolCall")
        .map((e) => e.text)
        .join("");
      const finalOutput = getFinalOutput(currentResult.messages);
      const displayText = streamText || finalOutput || "(running...)";
      // Live display: rebuild content from the ordered event log.
      const content: Array<{ type: string; text?: string; name?: string; args?: Record<string, unknown> }> =
        streamEvents.map((e) =>
          e.kind === "toolCall" ? { type: "toolCall", name: e.name, args: e.args } : { type: e.kind, text: e.text },
        );
      if (content.length === 0) {
        content.push({ type: "text", text: displayText });
      }
      onUpdate({
        content,
        // Results stay empty so renderResult keeps the streaming path; `live` carries
        // what the header needs (chain/parallel update wrappers read results[0] and
        // are unaffected).
        details: {
          ...makeDetails([]),
          live: { agent: agentName, source: agent.source, role, model, thinking: target?.thinking },
        },
      });
      // Footer status: guaranteed to render live in TUI
      ctx.ui.setStatus(
        "subagent",
        `[events:${eventCount} updates:${updateCount}] ${displayText.slice(0, 60)}${displayText.length > 60 ? "…" : ""}`,
      );
    }
  };

  // Build the steering handle
  const createHandle = (proc: ReturnType<typeof spawn>): SubagentHandle => ({
    steer: async (message: string) => {
      if (!isStreaming) return;
      writeRpcCommand(proc, { type: "steer", message });
      // Record the input so it shows in the live feed and the result display,
      // interleaved at the turn boundary it arrived at.
      streamEvents.push({ kind: "user", text: message });
      currentResult.userInputs?.push({ text: message, turn: turnCount });
      emitUpdate();
    },
    isStreaming: () => isStreaming,
    abort: () => {
      wasAborted = true;
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
    },
  });

  let handle: SubagentHandle | null = null;

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    // A sandbox marker inherited from the parent must not survive into a child that
    // did not ask for a sandbox: the child's gate would skip confirming its own,
    // unconfined shell. Children run with --no-extensions, so one that does not
    // declare sandbox-bash never clears the marker itself.
    const childEnv: Record<string, string | undefined> = { ...process.env, PI_SUBAGENT: "1" };
    delete childEnv[BASH_SANDBOX_ENV];

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: effectiveCwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"], // stdin for steering commands
        env: childEnv,
      });
      debugLog("spawn", 0, {
        agent: agentName,
        model: model ?? null,
        thinking: target?.thinking ?? null,
        command: invocation.command,
        args: invocation.args,
        pid: proc.pid ?? null,
        cwd: effectiveCwd,
        parentSandboxCommand: Boolean(process.env[SANDBOX_COMMAND_ENV]),
      });
      currentResult.pid = proc.pid;
      let stdoutBuffer = "";
      let stderrBuffer = "";
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      // Create handle before starting event loop
      handle = createHandle(proc);
      onHandle?.(handle);

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: RpcEvent;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        const eventType = event.type;
        eventCount++;

        // ── Agent lifecycle ──
        if (eventType === "agent_start") {
          // Ask once, as soon as the child is up: the path goes into the result so
          // a capped or failed run can still be read afterwards.
          if (!sentSessionQuery) {
            sentSessionQuery = true;
            writeRpcCommand(proc, { type: "get_state" });
          }
          // Reset streaming state for live display
          isStreaming = false;
          streamEvents.length = 0;
        }

        // ── Streaming events (for live display only) ──
        if (eventType === "message_update") {
          const assistantEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
          if (!assistantEvent) return;

          const deltaType = assistantEvent.type as string;
          isStreaming = true;

          if (deltaType === "text_delta") {
            const text = (assistantEvent.delta as string) || "";
            streamEvents.push({ kind: "text", text });
            emitUpdate();
          } else if (deltaType === "thinking_delta") {
            const text = (assistantEvent.delta as string) || "";
            streamEvents.push({ kind: "thinking", text });
            emitUpdate();
          }
        }

        // ── Tool execution start (for live tool call display) ──
        if (eventType === "tool_execution_start") {
          streamEvents.push({
            kind: "toolCall",
            name: (event.toolName as string) || "unknown",
            args: (event.args as Record<string, unknown>) || {},
          });
          debugLog("tool_start", 0, { toolName: event.toolName, totalCalls: streamEvents.length });
          emitUpdate();
        }

        // ── Tool execution end ──
        if (eventType === "tool_execution_end") {
          const toolResult = event.result as Record<string, unknown> | undefined;
          if (toolResult?.content && Array.isArray(toolResult.content)) {
            const content = toolResult.content as Array<{ type: string; text?: string }>;
            const textContent = content
              .filter((c) => c.type === "text")
              .map((c) => c.text || "")
              .join("\n");

            const toolResultMsg: Message = {
              role: "toolResult",
              toolCallId: (event.toolCallId as string) || `call_${Date.now()}`,
              toolName: (event.toolName as string) || "unknown",
              content: [{ type: "text", text: textContent }],
              isError: Boolean(toolResult.isError),
              timestamp: Date.now(),
            };
            currentResult.messages.push(toolResultMsg);
            emitUpdate();
          }
        }

        // ── Turn end (drives the maxTurns cap) ──
        // pi has no turn limit of its own, so the cap is enforced here: when the
        // turn count reaches maxTurns, send the RPC abort command. The child
        // aborts its active run and emits agent_end with the messages so far
        // (stopReason "aborted"), which the agent_end handler below collects.
        // Shortly before that, steer it once to write up what it has.
        if (eventType === "turn_end") {
          turnCount++;
          if (turnCount >= maxTurns) {
            maxTurnsReached = true;
            writeRpcCommand(proc, { type: "abort" });
            // Fallback: if agent_end doesn't arrive (abort raced a natural
            // completion), force-kill so the parent doesn't hang.
            if (killTimer) clearTimeout(killTimer);
            killTimer = setTimeout(() => {
              if (!proc.killed) {
                proc.kill("SIGTERM");
                if (!proc.killed) proc.kill("SIGKILL");
              }
            }, 3000);
          } else {
            steerNudge(nudgeState, maxTurns, turnCount, event.message, (message) => {
              writeRpcCommand(proc, { type: "steer", message });
              // Recorded like a user steer so it appears in the live feed and the
              // result display — otherwise the agent suddenly wrapping up looks
              // unexplained.
              streamEvents.push({ kind: "user", text: message });
              currentResult.userInputs?.push({ text: message, turn: turnCount });
              emitUpdate();
            });
          }
        }

        // ── Command responses ──
        if (eventType === "response") {
          if (event.command === "get_state") {
            const data = event.data as { sessionFile?: unknown } | undefined;
            if (typeof data?.sessionFile === "string") currentResult.sessionFile = data.sessionFile;
          }
        }

        // ── Agent end (source of truth — pi provides complete messages) ──
        if (eventType === "agent_end") {
          // pi retries a transient provider error in place: it emits this event with
          // willRetry, omits the failed turn from context, and continues the same
          // session. Aborting here would cancel that retry (and pi's backoff) and
          // force a whole-run restart, so this is not the run's end: keep what the
          // failed attempt produced and keep listening.
          const childWillRetry = childRetryPending(event);
          if (!childWillRetry) agentEndReceived = true;
          const agentMessages = event.messages as Record<string, unknown>[] | undefined;
          if (agentMessages && agentMessages.length > 0) {
            // Each agent_end reports that run's own messages, so an in-place retry
            // arrives as a second batch rather than an addition to the first.
            const incoming: Message[] = [];

            for (const rawMsg of agentMessages) {
              const role = rawMsg.role as string;
              if (role === "assistant") {
                // pi's assistant messages already have all required fields
                // Cast from Record to Message — pi constructs these internally
                const msg = rawMsg as unknown as Message;
                if (msg.role === "assistant") {
                  incoming.push(msg);
                  // Track model from last assistant message. A resolved target already
                  // names the ref the child was started with; the child's own id is the
                  // fallback for a run that used pi's default model.
                  if ("model" in msg) currentResult.model ??= msg.model as string;
                }
              } else if (role === "toolResult") {
                const msg = rawMsg as unknown as Message;
                if (msg.role === "toolResult") {
                  incoming.push(msg);
                }
              }
            }
            currentResult.messages = mergeAttemptMessages(currentResult.messages, incoming);

            // Real outcome from pi's last assistant message (stop/aborted/error),
            // not a fabricated count. The maxTurns override happens after the run.
            const lastAssistant = [...currentResult.messages].reverse().find((m) => m.role === "assistant");
            if (lastAssistant?.role === "assistant") {
              currentResult.stopReason = lastAssistant.stopReason;
              // The provider's own words beat "no output" when the caller reports the failure.
              if (lastAssistant.errorMessage) currentResult.errorMessage = lastAssistant.errorMessage;
              else delete currentResult.errorMessage;
            }

            // Update usage from agent_end stats
            const stats = event.stats as Record<string, unknown> | undefined;
            if (stats) {
              currentResult.usage.input += (stats.inputTokens as number) || 0;
              currentResult.usage.output += (stats.outputTokens as number) || 0;
              currentResult.usage.cacheRead += (stats.cacheReadTokens as number) || 0;
              currentResult.usage.cacheWrite += (stats.cacheWriteTokens as number) || 0;
              currentResult.usage.cost += (stats.cost as number) || 0;
              currentResult.usage.contextTokens = (stats.contextTokens as number) || 0;
              currentResult.usage.turns = currentResult.messages.filter((m) => m.role === "assistant").length;
            }

            emitUpdate();
            if (childWillRetry) {
              debugLog("agentRetry", 0, {
                agent: agentName,
                stopReason: currentResult.stopReason ?? null,
                error: currentResult.errorMessage ?? null,
              });
              return;
            }
            // Clear footer status on completion
            ctx.ui.setStatus("subagent", undefined);
            // Pi's RPC mode runs `return new Promise(() => {})` to keep alive forever —
            // no shutdown command. Closing stdin triggers the child's onInputEnd handler,
            // which calls shutdown() with the default exit code 0 (clean exit). The abort
            // command first cancels any in-flight operation so dispose() is clean.
            // SIGTERM was previously used here, but its handler hard-codes exit 143, which
            // the parent read as a failure (isError = exitCode !== 0) and wrapped the
            // result as "Agent failed:" even on a successful run.
            if (proc.stdin) {
              proc.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
              proc.stdin.end();
            }
            // Escalation fallback if stdin-close doesn't exit the child within 3s.
            killTimer = setTimeout(() => {
              if (!proc.killed) {
                proc.kill("SIGTERM");
                if (!proc.killed) proc.kill("SIGKILL");
              }
            }, 3000);
          }
        }

        // ── Queue update (for steering) ──
        if (eventType === "queue_update") {
          // Steering messages are queued — isStreaming tells us if we can send more
        }

        // ── Extension UI request relay (permission gate, etc.) ──
        // Subagent's ctx.ui.confirm()/select()/input() emit these on stdout.
        // Relay to parent's TUI, then send response back on stdin.
        if (eventType === "extension_ui_request") {
          const method = event.method as string;
          const requestId = event.id as string;
          // Fire-and-forget methods — no response needed
          if (
            method === "notify" ||
            method === "setStatus" ||
            method === "setWorkingMessage" ||
            method === "setWorkingVisible" ||
            method === "setWorkingIndicator" ||
            method === "setHiddenThinkingLabel" ||
            method === "setWidget" ||
            method === "setFooter" ||
            method === "setHeader" ||
            method === "setTitle" ||
            method === "pasteToEditor" ||
            method === "setEditorText" ||
            method === "addAutocompleteProvider" ||
            method === "setEditorComponent"
          ) {
            return;
          }
          if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor") {
            return;
          }
          // Already waiting on a dialog — ignore (permission gate shouldn't stack)
          if (pendingDialogs.has(requestId)) return;

          // Create a placeholder entry — the actual Promise is created by ctx.ui.confirm()
          // below. We just track the requestId to prevent duplicate handling.
          const timer = setTimeout(() => {
            pendingDialogs.delete(requestId);
            // Send cancellation to subagent so it doesn't hang forever
            writeRpcCommand(proc, { type: "extension_ui_response", id: requestId, cancelled: true });
          }, DIALOG_TIMEOUT_MS);
          pendingDialogs.set(requestId, { resolve: () => {}, reject: () => {}, timer });

          // Store the actual resolve/reject so the extension_ui_response handler
          // can resolve the child's ctx.ui.custom() Promise.
          const entry = pendingDialogs.get(requestId);
          if (!entry) return;
          entry.resolve = () => {
            pendingDialogs.delete(requestId);
            clearTimeout(entry.timer);
          };
          entry.reject = () => {
            pendingDialogs.delete(requestId);
            clearTimeout(entry.timer);
          };

          // Relay to parent's TUI. The await blocks this async fn but NOT the event
          // loop — when the parent responds, the Promise resolves synchronously,
          // scheduling a microtask that continues this relay after the current sync
          // code finishes.
          const relayToParent = async () => {
            try {
              let result: unknown;
              if (method === "confirm") {
                const title = (event.title as string) || "Permission";
                const message = (event.message as string) || "";
                result = await ctx.ui.confirm(title, message, { timeout: event.timeout as number | undefined });
              } else if (method === "select") {
                const title = (event.title as string) || "Select";
                const options = (event.options as string[]) || [];
                result = await ctx.ui.select(title, options, { timeout: event.timeout as number | undefined });
              } else if (method === "input") {
                const title = (event.title as string) || "Input";
                const placeholder = (event.placeholder as string) || "";
                result = await ctx.ui.input(title, placeholder, { timeout: event.timeout as number | undefined });
              } else {
                // editor — not supported in relay, auto-cancel
                result = undefined;
              }
              // Send response back to subagent
              writeRpcCommand(proc, {
                type: "extension_ui_response",
                id: requestId,
                value: result,
                confirmed: method === "confirm" ? result : undefined,
                cancelled: !result,
              });
            } catch {
              // Dialog was cancelled/timed out — send cancellation
              writeRpcCommand(proc, { type: "extension_ui_response", id: requestId, cancelled: true });
            } finally {
              pendingDialogs.delete(requestId);
            }
          };

          relayToParent().catch(() => {
            // Relay failed (timeout, abort) — already sent cancellation above
          });
        }

        // ── Extension error ──
        if (eventType === "extension_error") {
          const extPath = event.extensionPath as string;
          const error = event.error as string;
          currentResult.stderr += `[extension error: ${extPath}] ${error}\n`;
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      proc.on("close", (code: number | null) => {
        if (stdoutBuffer.trim()) processLine(stdoutBuffer);
        currentResult.stderr += stderrBuffer;
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        debugLog("close", 0, {
          agent: agentName,
          exitCode: code ?? 0,
          events: eventCount,
          stopReason: currentResult.stopReason ?? null,
          sessionFile: currentResult.sessionFile ?? null,
          stderrTail: currentResult.stderr.slice(-400),
        });
        resolve(code ?? 0);
      });

      proc.on("error", (err: Error) => {
        // A spawn failure emits this instead of close: without recording it, the
        // attempt resolves with empty everything and the failure is invisible.
        debugLog("spawnError", 0, {
          agent: agentName,
          pid: proc.pid ?? null,
          code: (err as NodeJS.ErrnoException).code ?? null,
          message: err.message,
        });
        currentResult.errorMessage = `spawn failed: ${err.message}`;
        currentResult.stderr += `spawn: ${err.message}\n`;
        resolve(1);
      });

      // Abort signal
      if (signal) {
        const killProc = () => {
          wasAborted = true;
          handle?.abort();
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }

      // Send initial prompt
      writeRpcCommand(proc, { type: "prompt", message: taskWithBudget(task, maxTurns) });
    });

    currentResult.exitCode = exitCode;
    const reason = exitStopReason(maxTurnsReached, wasAborted, agentEndReceived, currentResult.stopReason);
    if (reason) currentResult.stopReason = reason;
    return currentResult;
  } finally {
    cleanup();
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}
