/**
 * policy-guard: refuse a tool call that breaks a project's policy.
 *
 * The policy is prose, per project, in `~/notes/llm/<project>/.agents/policy.json`.
 * No command list lives in this extension: a decision model reads one call against
 * the clauses, one question per clause, and the threshold that turns an answer into
 * a refusal is a number in the file. The verdict is a floor. Nothing auto-allows it,
 * there is no per-call dialog, and the only unlocks are the user-typed `/guard allow`
 * and `/guard off`.
 *
 * Every tool call is judged, not just bash: a clause can be about a path, a url, a
 * dispatch or a command, and the call summary carries whichever of those the tool
 * named. A call that names none of them is skipped, because no clause can act on a
 * bare tool name and a request per call is paid for by every session.
 *
 * Failures are visible, and mostly open. No policy file means nothing is judged; the
 * policy file itself is still floored. An unreadable policy, a missing credential or an
 * unavailable judge notifies the user once and lets the call through: a classifier outage
 * that blocks every call costs more than one that reports itself, and the report is what
 * keeps it from being silent.
 *
 * Commands: /guard status | allow | revoke | off | on.
 *
 * The rules also reach the agent without a refusal: the first turn of a session
 * carries the clause list, rendered from the policy file, and it is carried again when the
 * copy in context is out of date. That block names the file, so the file is floored
 * against writes: an agent that can edit its own rules has no rules.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_DECISIONS_MODEL, decisionsComplete } from "../shared/decisions";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import { journalNotesDir, projectFor } from "../shared/journal-context";
import { resolveProviderAuth } from "../shared/model-roles";
import {
  type CallFacts,
  callSummary,
  hasContent,
  judgePolicy,
  type Policy,
  type PolicyAsk,
  type PolicyVerdict,
  policySummary,
} from "../shared/policy";
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
const POLICY_FILE = join(".agents", "policy.json");
export const DECISIONS_PATH = join(homedir(), ".pi", "agent", "state", "policy-guard.log");
/** The session entry type the rules block is written under. */
const POLICY_CUSTOM_TYPE = "policy-guard-policy";

/** A file the guard enforces is not a file the agent writes. Case-folded: APFS
 * opens `Policy.json` as the same file. */
const POLICY_NAME = /(^|\/)\.agents\/policy\.json$/i;

const POLICY_WRITE_REASON =
  "[policy-guard] refused: a project's policy is the user's to edit. Name the rule you think is wrong instead of writing it.";

const POLICY_SHELL_REASON =
  "[policy-guard] refused: a shell command that names a policy file. The guard does not parse shell to tell a read from a write, so read the file with the read tool; the user is the one who changes it.";

/** pi's write and edit tools strip a leading `@`, and a `~` names the home directory. */
function resolveTarget(path: string, cwd: string): string {
  const bare = path.trim().replace(/^@/, "");
  const expanded = bare === "~" || bare.startsWith("~/") ? join(homedir(), bare.slice(1)) : bare;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/** Whether a path names a policy file, by its own form or its resolved one. */
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

/** The text a projected message carries, when it carries one. */
function messageText(message: unknown): string | null {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((part) => ((part as { type?: string }).type === "text" ? ((part as { text?: string }).text ?? "") : ""))
    .join("");
}

/**
 * The last policy block the model can still see, read from the session projection. The
 * projection is what the model actually gets: it follows the leaf, applies a compaction's
 * kept window and honours a context edit, none of which a flag in this process can know.
 */
function lastBlockContent(ctx: ExtensionContext): string | null {
  const projection = ctx.sessionManager.buildSessionProjection();
  for (let index = projection.entries.length - 1; index >= 0; index--) {
    const projected = projection.entries[index];
    const source = projected.sourceEntry;
    if (source.type !== "custom_message" || source.customType !== POLICY_CUSTOM_TYPE) continue;
    // A replaced entry contributes text that is no longer this block, and an omitted one
    // contributes none: neither is a copy the model can read as the rules.
    const own = typeof source.content === "string" ? source.content : null;
    const text = projected.messages.map(messageText).find((value): value is string => value !== null);
    if (text === undefined || text !== own) continue;
    return text;
  }
  return null;
}

/** The clauses judged against the neutral pair, named so the author can add their own. */
function defaultCriteriaLine(policy: Policy): string {
  const defaults = policy.clauses.filter((clause) => !clause.criteria).map((clause) => clause.id);
  return defaults.length > 0 ? `clauses on the default criteria: ${defaults.join(", ")}` : "";
}

export interface PolicyGuardOverrides {
  /** Bypass the decision model (tests): answers the questions directly. */
  ask?: PolicyAsk;
  /** Bypass the notes-tree lookup (tests): where this cwd's policy lives. */
  policyPath?: (cwd: string) => string;
  /** Where decisions are recorded (tests); defaults to the state directory. */
  decisionsPath?: string;
}

export default function policyGuardExtension(pi: ExtensionAPI, overrides: PolicyGuardOverrides = {}) {
  let granted = false;
  let off = false;
  let policy: Policy | null = null;
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

  /** The clauses no refusal this session has cited; one that is never cited may be dead or misworded. */
  function neverCitedLine(current: Policy, ctx: ExtensionContext): string {
    const session = ctx.sessionManager.getSessionId();
    const fired = new Set(
      readDecisions()
        .filter((record) => record.session === session)
        .flatMap((record) => (record.clause === null ? [] : [record.clause])),
    );
    const never = current.clauses.filter((clause) => !fired.has(clause.id)).map((clause) => clause.id);
    return never.length > 0 ? `never cited by a refusal this session: ${never.join(", ")}` : "";
  }

  /** A call in one line, for the decision record: the command, or the path it targets. */
  function describeCall(facts: CallFacts): string {
    return facts.command ?? facts.paths?.[0] ?? facts.url ?? facts.query ?? facts.task ?? facts.tool;
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
        `policy-guard: ${loaded.path} is not usable, so no policy is enforced: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more, see /guard status)` : ""}`,
      );
    }
  }

  async function judge(ctx: ExtensionContext, current: Policy, facts: CallFacts): Promise<PolicyVerdict | null> {
    let ask: PolicyAsk;
    if (overrides.ask) {
      ask = overrides.ask;
    } else {
      const auth = await resolveProviderAuth(PROVIDER, ctx.modelRegistry);
      if (!auth?.apiKey) {
        notifyOnce(ctx, "no-auth", `policy-guard: no credential for ${PROVIDER}; no policy is enforced`);
        return null;
      }
      const options = { apiKey: auth.apiKey, headers: auth.headers, timeoutMs: TIMEOUT_MS, signal: ctx.signal };
      ask = async (questions, state) => (await decisionsComplete({ model: MODEL, state, questions }, options)).answers;
    }
    try {
      const verdict = await judgePolicy(ask, current, facts, THRESHOLD);
      if (verdict.missing.length > 0) {
        // A gap is reported once per session: the clauses it names were not checked, and
        // the rest of the verdict still stands.
        notifyOnce(
          ctx,
          "incomplete",
          `policy-guard: the judge did not answer for ${verdict.missing.join(", ")}; those clauses were not checked`,
        );
      }
      return verdict;
    } catch (err) {
      notifyOnce(
        ctx,
        "judge-failed",
        `policy-guard: the judge failed, so policy checks are skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    granted = false;
    off = false;
    verdicts.clear();
    notified.clear();
    if (NUMBERS.warnings.length > 0) notifyOnce(ctx, "bad-numbers", `policy-guard: ${NUMBERS.warnings.join("; ")}`);
    trimDecisions();
    refresh(ctx);
  });

  // The rules are in context from the first turn, rendered from the file the judge reads.
  // Subagents get it too: a child running bash in this project meets the same floor. It is
  // carried again when the rendering changes or an earlier copy is gone, and a copy sent beside
  // one that is still there is marked as the current one.
  pi.on("before_agent_start", async (_event, ctx) => {
    refresh(ctx);
    const current = policy;
    if (!current) return;
    const plain = policySummary(current, policyPath);
    const marked = policySummary(current, policyPath, { supersedes: true });
    const last = lastBlockContent(ctx);
    if (last === plain || last === marked) return;
    return {
      message: { customType: POLICY_CUSTOM_TYPE, content: last === null ? plain : marked, display: false },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (off) return;
    const input = event.input as Record<string, unknown>;
    const facts = callSummary(event.toolName, input, ctx.cwd, (path) => resolveTarget(path, ctx.cwd));
    const write = policyWriteReason(event.toolName, input, ctx.cwd);
    if (write) {
      recordDecision(ctx, event.toolName === "bash" ? "policy-shell" : "policy-write", describeCall(facts), null);
      return { block: true, reason: write };
    }
    // A host grant is about host work, so it covers bash and nothing else.
    if (event.toolName === "bash" && granted) return;
    // A call that names nothing a clause could be about is not judged.
    if (!hasContent(facts)) return;
    refresh(ctx);
    const current = policy;
    if (!current) return;
    const key = JSON.stringify(facts);
    let verdict = verdicts.get(key);
    if (!verdict) {
      const judged = await judge(ctx, current, facts);
      if (!judged) return;
      recordDecision(ctx, "policy", describeCall(facts), judged);
      verdict = judged;
      verdicts.set(key, verdict);
    }
    if (!verdict.violation) return;
    return { block: true, reason: refusalText(current, verdict, { policyPath, tool: event.toolName }) };
  });

  pi.registerCommand("guard", {
    description: "Project policy guard: status, allow (host work for this session), revoke, off, on",
    getArgumentCompletions: (prefix) =>
      ["status", "allow", "revoke", "off", "on"]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: `${name} `, label: name })),
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/)[0]?.toLowerCase() || "status";
      refresh(ctx);
      if (action === "allow") {
        granted = true;
        ctx.ui.notify("policy-guard: host work allowed for this session", "info");
        return;
      }
      if (action === "revoke") {
        granted = false;
        ctx.ui.notify("policy-guard: host grant revoked", "info");
        return;
      }
      if (action === "off") {
        off = true;
        ctx.ui.notify("policy-guard: policy checks off for this session", "info");
        return;
      }
      if (action === "on") {
        off = false;
        ctx.ui.notify("policy-guard: policy checks on", "info");
        return;
      }
      if (action !== "status") {
        ctx.ui.notify(`policy-guard: unknown action "${action}" (status, allow, revoke, off, on)`, "warning");
        return;
      }
      const lines = [
        `policy: ${policyPath}`,
        policy
          ? `project: ${policy.project}; clauses: ${policy.clauses.length}`
          : off
            ? "project: none (no usable policy file; the guard is off, so nothing is refused)"
            : "project: none (no usable policy file, so only the policy file itself is refused)",
        // A clause without criteria is judged against the neutral pair, which is what a
        // permission gets wrong; naming them is the only place the author sees it.
        ...(policy ? [defaultCriteriaLine(policy), neverCitedLine(policy, ctx)] : []),
        `state: ${off ? "off" : "on"}${granted ? ", host granted for this session" : ""}`,
        `judge: ${MODEL} via ${PROVIDER}, threshold ${THRESHOLD}`,
        errors.length > 0 ? `errors: ${errors.join("; ")}` : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerTool({
    name: "policy",
    label: "Project policy",
    description:
      "This project's policy: the rules the guard enforces, whether they loaded, the session's guard state, and the newest calls the guard has judged in this session. Read-only; the rules file is the user's to edit.",
    parameters: Type.Object({}),
    promptSnippet:
      "policy: the project's policy, its load state, this session's guard state, and the newest calls the guard has judged this session.",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      refresh(ctx);
      const lines: string[] = [];
      if (policy) {
        lines.push(policySummary(policy, policyPath));
      } else {
        lines.push(`No usable policy at ${policyPath}.`);
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
