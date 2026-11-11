/**
 * env-guard: refuse host work that a project's environment policy keeps in a
 * container.
 *
 * The policy is prose, per project, in
 * `~/notes/llm/<project>/.agents/environment.json`. No command list lives in
 * this extension: a decision model reads the command and the clauses and answers
 * two questions, should this be refused and which clause fired. The verdict is a
 * floor. Nothing auto-allows it, there is no per-call dialog, and the only unlocks
 * are the user-typed `/guard allow` and `/guard off`.
 *
 * Failures are visible, and mostly open. No policy file means nothing is judged; the
 * policy file itself is still floored. An unreadable policy, a missing credential or an
 * unavailable judge notifies the user once and lets the call through: a classifier outage
 * that blocks every bash call costs more than one that reports itself, and the report is
 * what keeps it from being silent. The citation request is the exception: it runs only
 * after a refusal is decided, so a failure there keeps the refusal and loses the clause.
 *
 * Commands: /guard status | allow | revoke | off | on.
 *
 * The rules also reach the agent without a refusal: the first turn of a session
 * carries the clause list, rendered from the policy file. That block names the
 * file, so the file is floored against writes: an agent that can edit its own
 * rules has no rules.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_DECISIONS_MODEL, decisionsComplete } from "../shared/decisions";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import {
  buildPolicyState,
  type EnvPolicy,
  judgePolicy,
  type PolicyAsk,
  type PolicyVerdict,
  policySummary,
} from "../shared/env-policy";
import { journalNotesDir, projectFor } from "../shared/journal-context";
import { resolveProviderAuth } from "../shared/model-roles";
import {
  commandLine,
  type DecisionKind,
  FILE_LIMIT,
  formatDecision,
  type GuardDecision,
  parseDecisions,
  sessionView,
  trimLines,
} from "./decisions";
import { guardNumbers } from "./numbers";
import { createPolicySource } from "./policy-source";
import { refusalText } from "./refusal";

const PROVIDER = process.env.PI_GUARD_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_GUARD_MODEL ?? DEFAULT_DECISIONS_MODEL;
const NUMBERS = guardNumbers(process.env);
const THRESHOLD = NUMBERS.threshold;
const TIMEOUT_MS = NUMBERS.timeoutMs;
const POLICY_FILE = join(".agents", "environment.json");
const DECISIONS_PATH = join(homedir(), ".pi", "agent", "state", "env-guard.log");

/** A file the guard enforces is not a file the agent writes. Case-folded: APFS
 * opens `Environment.json` as the same file. */
const POLICY_NAME = /(^|\/)\.agents\/environment\.json$/i;

const POLICY_WRITE_REASON =
  "[env-guard] refused: a project's environment policy is the user's to edit. Name the rule you think is wrong instead of writing it.";

const POLICY_SHELL_REASON =
  "[env-guard] refused: a shell command that names an environment policy. The guard does not parse shell to tell a read from a write, so read the file with the read tool; the user is the one who changes it.";

/** pi's write and edit tools strip a leading `@`, so a target path is read the same way. */
function resolveTarget(path: string, cwd: string): string {
  const bare = path.trim().replace(/^@/, "");
  return isAbsolute(bare) ? bare : resolve(cwd, bare);
}

/** Whether a path names an environment policy, by its own form or its resolved one. */
function isPolicyPath(path: string): boolean {
  if (POLICY_NAME.test(normalize(path))) return true;
  try {
    return POLICY_NAME.test(realpathSync(path));
  } catch {
    return false;
  }
}

/**
 * The write floor for the policy: an agent that can edit its own rules has no
 * rules. Edit-like tools are matched by target path. A shell command is matched by
 * text and refused whether it reads or writes, because telling those apart is shell
 * parsing; the refusal names the read tool as the way in.
 *
 * No loaded policy is needed: the rule is about the file, not about what this
 * session enforces, so a session in a project without a policy cannot rewrite
 * another project's.
 */
function policyWriteReason(toolName: string, input: Record<string, unknown>, cwd: string): string | null {
  if (EDIT_LIKE_TOOLS.includes(toolName)) {
    const targets = collectToolPaths(toolName, input).map((path) => resolveTarget(path, cwd));
    return targets.some(isPolicyPath) ? POLICY_WRITE_REASON : null;
  }
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && command.toLowerCase().includes(POLICY_FILE) ? POLICY_SHELL_REASON : null;
}

export interface EnvGuardOverrides {
  /** Bypass the decision model (tests): answers the questions directly. */
  ask?: PolicyAsk;
  /** Bypass the notes-tree lookup (tests): where this cwd's policy lives. */
  policyPath?: (cwd: string) => string;
  /** Where decisions are recorded (tests); defaults to the state directory. */
  decisionsPath?: string;
}

export default function envGuardExtension(pi: ExtensionAPI, overrides: EnvGuardOverrides = {}) {
  let granted = false;
  let off = false;
  let summarySent = false;
  let policy: EnvPolicy | null = null;
  let policyPath = "";
  let errors: string[] = [];
  /** Verdicts by command. Failures are not cached, so a retry retries. */
  const verdicts = new Map<string, PolicyVerdict>();
  const notified = new Set<string>();
  const decisionsPath = overrides.decisionsPath ?? DECISIONS_PATH;

  /** Append one decision. A log that cannot be written must not change a verdict. */
  function recordDecision(
    ctx: ExtensionContext,
    kind: DecisionKind,
    command: string,
    verdict: PolicyVerdict | null,
  ): void {
    try {
      const record: GuardDecision = {
        at: new Date().toISOString(),
        session: ctx.sessionManager.getSessionId(),
        project: policy?.project ?? "",
        kind,
        command: commandLine(command),
        violated: verdict?.violation ?? true,
        clause: verdict?.clause ?? null,
        probability: verdict?.probability ?? null,
        threshold: verdict?.threshold ?? THRESHOLD,
      };
      mkdirSync(dirname(decisionsPath), { recursive: true });
      appendFileSync(decisionsPath, formatDecision(record));
    } catch {
      // Swallowed on purpose: losing a record is cheaper than losing a refusal.
    }
  }

  function readDecisions(): GuardDecision[] {
    try {
      // Whole file: `trimDecisions` bounds it, and filtering after a tail slice would let
      // another window's records push this session's out of the view.
      return parseDecisions(readFileSync(decisionsPath, "utf-8"));
    } catch {
      return [];
    }
  }

  /**
   * Drop the oldest records at session start, so the file stays bounded. This is the
   * only reader that writes, so an append landing between the read and the rewrite is
   * lost; the record is a calibration set, not a ledger of record.
   */
  function trimDecisions(): void {
    try {
      const raw = readFileSync(decisionsPath, "utf-8");
      const kept = trimLines(raw, FILE_LIMIT);
      if (kept !== raw) writeFileSync(decisionsPath, kept);
    } catch {
      // No log yet, or one that cannot be read: nothing to trim.
    }
  }

  /** A call in one line, for the decision record: the command, or the path it targets. */
  function describeCall(toolName: string, input: Record<string, unknown>): string {
    if (typeof input.command === "string") return input.command;
    return collectToolPaths(toolName, input)[0] ?? toolName;
  }

  const source = createPolicySource({
    pathFor: (cwd) => overrides.policyPath?.(cwd) ?? join(projectFor(journalNotesDir(), cwd).dir, POLICY_FILE),
    stat: (path) => {
      try {
        return { mtimeMs: statSync(path).mtimeMs };
      } catch {
        return null;
      }
    },
    read: (path) => readFileSync(path, "utf-8"),
  });

  function notifyOnce(ctx: ExtensionContext, key: string, message: string): void {
    if (notified.has(key)) return;
    notified.add(key);
    ctx.ui.notify(message, "warning");
  }

  /** Load the policy; a change drops cached verdicts so none outlives an edit. */
  function refresh(ctx: ExtensionContext): void {
    const loaded = source.load(ctx.cwd);
    policyPath = loaded.path;
    policy = loaded.policy;
    errors = loaded.errors;
    if (!loaded.changed) return;
    verdicts.clear();
    if (errors.length > 0) {
      notifyOnce(
        ctx,
        `unusable:${loaded.path}`,
        `env-guard: ${loaded.path} is not usable, so no policy is enforced: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more, see /guard status)` : ""}`,
      );
    }
  }

  async function judge(ctx: ExtensionContext, current: EnvPolicy, command: string): Promise<PolicyVerdict | null> {
    let ask: PolicyAsk;
    if (overrides.ask) {
      ask = overrides.ask;
    } else {
      const auth = await resolveProviderAuth(PROVIDER, ctx.modelRegistry);
      if (!auth?.apiKey) {
        notifyOnce(ctx, "no-auth", `env-guard: no credential for ${PROVIDER}; no policy is enforced`);
        return null;
      }
      const options = { apiKey: auth.apiKey, headers: auth.headers, timeoutMs: TIMEOUT_MS, signal: ctx.signal };
      ask = async (questions, state) => (await decisionsComplete({ model: MODEL, state, questions }, options)).answers;
    }
    try {
      const verdict = await judgePolicy(
        ask,
        current,
        buildPolicyState({ command, project: current.project, cwd: ctx.cwd }),
        THRESHOLD,
      );
      if (!verdict) {
        notifyOnce(ctx, "incomplete", "env-guard: the judge answered incompletely; that call was not checked");
      }
      return verdict;
    } catch (err) {
      notifyOnce(
        ctx,
        "judge-failed",
        `env-guard: the judge failed, so policy checks are skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    granted = false;
    off = false;
    summarySent = false;
    verdicts.clear();
    notified.clear();
    if (NUMBERS.warnings.length > 0) notifyOnce(ctx, "bad-numbers", `env-guard: ${NUMBERS.warnings.join("; ")}`);
    trimDecisions();
    refresh(ctx);
  });

  // The rules are in context from the first turn, rendered from the file the judge
  // reads. Subagents get it too: a child running bash in this project meets the
  // same floor.
  pi.on("before_agent_start", async (_event, ctx) => {
    if (summarySent) return;
    refresh(ctx);
    const current = policy;
    if (!current) return;
    summarySent = true;
    return {
      message: { customType: "env-guard-policy", content: policySummary(current, policyPath), display: false },
    };
  });

  // Compaction summarizes the injected block away, so the next turn carries it again.
  pi.on("session_before_compact", async () => {
    summarySent = false;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (off) return;
    const write = policyWriteReason(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
    if (write) {
      const input = event.input as Record<string, unknown>;
      recordDecision(
        ctx,
        event.toolName === "bash" ? "policy-shell" : "policy-write",
        describeCall(event.toolName, input),
        null,
      );
      return { block: true, reason: write };
    }
    if (event.toolName !== "bash" || granted) return;
    refresh(ctx);
    const current = policy;
    if (!current) return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim() === "") return;
    let verdict = verdicts.get(command);
    if (!verdict) {
      const judged = await judge(ctx, current, command);
      if (!judged) return;
      recordDecision(ctx, "policy", command, judged);
      verdict = judged;
      verdicts.set(command, verdict);
    }
    if (!verdict.violation) return;
    return { block: true, reason: refusalText(current, verdict, command, { cwd: ctx.cwd, policyPath }) };
  });

  pi.registerCommand("guard", {
    description: "Environment policy guard: status, allow (host work for this session), revoke, off, on",
    getArgumentCompletions: (prefix) =>
      ["status", "allow", "revoke", "off", "on"]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: `${name} `, label: name })),
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
      refresh(ctx);
      if (action === "allow") {
        granted = true;
        ctx.ui.notify("env-guard: host work allowed for this session", "info");
        return;
      }
      if (action === "revoke") {
        granted = false;
        ctx.ui.notify("env-guard: host grant revoked", "info");
        return;
      }
      if (action === "off") {
        off = true;
        ctx.ui.notify("env-guard: policy checks off for this session", "info");
        return;
      }
      if (action === "on") {
        off = false;
        ctx.ui.notify("env-guard: policy checks on", "info");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify(`env-guard: unknown action "${action}" (status, allow, revoke, off, on)`, "warning");
        return;
      }
      const lines = [
        `policy: ${policyPath}`,
        policy
          ? `project: ${policy.project}; environment: ${policy.environment}; clauses: ${policy.clauses.length}`
          : off
            ? "project: none (no usable policy file; the guard is off, so nothing is refused)"
            : "project: none (no usable policy file, so only the policy file itself is refused)",
        `state: ${off ? "off" : "on"}${granted ? ", host granted for this session" : ""}`,
        `judge: ${MODEL} via ${PROVIDER}, threshold ${THRESHOLD}`,
        errors.length > 0 ? `errors: ${errors.join("; ")}` : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "env_policy",
    label: "Environment policy",
    description:
      "This project's environment policy: the rules the guard enforces, whether they loaded, the session's guard state, and the newest calls the guard has judged in this session. Read-only; the rules file is the user's to edit.",
    parameters: Type.Object({}),
    promptSnippet:
      "env_policy: the project's environment policy, its load state, this session's guard state, and the newest calls the guard has judged this session.",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      const lines: string[] = [];
      if (policy) {
        lines.push(policySummary(policy, policyPath));
      } else {
        lines.push(`No usable environment policy at ${policyPath}.`);
        if (errors.length > 0) lines.push(`errors: ${errors.join("; ")}`);
      }
      lines.push("", `state: ${off ? "off" : "on"}; host grant: ${granted ? "given for this session" : "not given"}`);
      const view = sessionView(readDecisions(), ctx.sessionManager.getSessionId());
      lines.push(
        "",
        view.length > 0 ? `judged in this session (newest ${view.length}):` : "judged in this session: none yet",
      );
      lines.push(...view);
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: {} };
    },
  });
}
