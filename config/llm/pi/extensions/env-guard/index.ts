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
 * Failures are visible, and mostly open. No policy file means no guard. An
 * unreadable policy, a missing credential or an unavailable judge notifies the
 * user once and lets the call through: a classifier outage that blocks every bash
 * call costs more than one that reports itself, and the report is what keeps it
 * from being silent. The citation request is the exception: it runs only after a
 * refusal is decided, so a failure there keeps the refusal and loses the clause.
 *
 * Commands: /guard status | allow | revoke | off | on.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_DECISIONS_MODEL, decisionsComplete } from "../shared/decisions";
import {
  buildPolicyState,
  type EnvPolicy,
  judgePolicy,
  type PolicyAsk,
  type PolicyVerdict,
} from "../shared/env-policy";
import { journalNotesDir, projectFor } from "../shared/journal-context";
import { resolveProviderAuth } from "../shared/model-roles";
import { guardNumbers } from "./numbers";
import { createPolicySource } from "./policy-source";
import { refusalText } from "./refusal";

const PROVIDER = process.env.PI_GUARD_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_GUARD_MODEL ?? DEFAULT_DECISIONS_MODEL;
const NUMBERS = guardNumbers(process.env);
const THRESHOLD = NUMBERS.threshold;
const TIMEOUT_MS = NUMBERS.timeoutMs;
const POLICY_FILE = join(".agents", "environment.json");

export interface EnvGuardOverrides {
  /** Bypass the decision model (tests): answers the questions directly. */
  ask?: PolicyAsk;
  /** Bypass the notes-tree lookup (tests): where this cwd's policy lives. */
  policyPath?: (cwd: string) => string;
}

export default function envGuardExtension(pi: ExtensionAPI, overrides: EnvGuardOverrides = {}) {
  let granted = false;
  let off = false;
  let policy: EnvPolicy | null = null;
  let policyPath = "";
  let errors: string[] = [];
  /** Verdicts by command. Failures are not cached, so a retry retries. */
  const verdicts = new Map<string, PolicyVerdict>();
  const notified = new Set<string>();

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
    verdicts.clear();
    notified.clear();
    if (NUMBERS.warnings.length > 0) notifyOnce(ctx, "bad-numbers", `env-guard: ${NUMBERS.warnings.join("; ")}`);
    refresh(ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || granted || off) return;
    refresh(ctx);
    const current = policy;
    if (!current) return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim() === "") return;
    let verdict = verdicts.get(command);
    if (!verdict) {
      const judged = await judge(ctx, current, command);
      if (!judged) return;
      verdict = judged;
      verdicts.set(command, verdict);
    }
    if (!verdict.violation) return;
    return { block: true, reason: refusalText(current, verdict, command, ctx.cwd) };
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
          : "project: none (no policy file, so nothing is refused)",
        `state: ${off ? "off" : "on"}${granted ? ", host granted for this session" : ""}`,
        `judge: ${MODEL} via ${PROVIDER}, threshold ${THRESHOLD}`,
        errors.length > 0 ? `errors: ${errors.join("; ")}` : "",
      ].filter(Boolean);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
