/**
 * Which model and thinking level a subagent runs.
 *
 * The caller resolves the role chain (which needs the model registry and auth) and hands
 * the entries in, so the precedence rules are testable without a registry. The thinking
 * vocabulary comes from `../shared/model-roles`, the one home for it.
 *
 * Precedence, highest first:
 *   1. a pinned `model:` — self-contained, so a project agent committed to another
 *      repository carries its own model instead of depending on a machine's roles.json
 *   2. the declared `role:` chain
 *   3. the default `subagent` role chain
 *   4. nothing: the child runs pi's own default model and level
 *
 * `thinking:` overrides the level of every chain attempt, and is the level for a
 * pinned model. Without one, a pinned model leaves pi's own default in place, while a
 * chain entry with no level means `off` (the rule `sidecarComplete` applies too).
 */

import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../shared/model-roles";

/** Role an agent falls back to when it declares neither `role:` nor `model:`. It is a
 * normal entry in roles.json, so /sidecar-models edits its chain and levels. */
export const DEFAULT_SUBAGENT_ROLE = "subagent";

/** One attempt's model and thinking level. */
export interface AttemptTarget {
  ref: string;
  /** Omitted when nothing pins a level: the child then uses pi's own default. */
  thinking?: ThinkingLevel;
}

/** What an agent resolves to: its fallback targets, the role they came from, and a
 * config error to report instead of running. */
export interface AgentTargets {
  targets: AttemptTarget[];
  /** Set for a role-based chain, so a result can name the role it used. */
  role?: string;
  error?: string;
}

/** A resolved chain entry: the ref to pass as `--model`, and its configured level. */
export interface ChainEntry {
  ref: string;
  thinking?: ThinkingLevel;
}

/** The child's model flags for one attempt. `--thinking` is passed only with a level, so
 * an unset one leaves pi's own default in place. */
export function targetArgs(target: AttemptTarget): string[] {
  const args = ["--model", target.ref];
  if (target.thinking) args.push("--thinking", target.thinking);
  return args;
}

/** The agent fields that decide a target. */
export interface TargetSpec {
  name: string;
  model?: string;
  role?: string;
  thinking?: string;
}

export function planAgentTargets(agent: TargetSpec, chain: readonly ChainEntry[]): AgentTargets {
  if (agent.thinking && !isThinkingLevel(agent.thinking)) {
    return {
      targets: [],
      // Name the role the level was meant for, so the header is not just "(user)".
      // A pinned model needs none: the error result names the ref it failed on.
      role: agent.model ? undefined : (agent.role ?? DEFAULT_SUBAGENT_ROLE),
      error: `Agent "${agent.name}" has an invalid thinking level "${agent.thinking}". Valid: ${THINKING_LEVELS.join(", ")}.`,
    };
  }
  const thinking: ThinkingLevel | undefined = isThinkingLevel(agent.thinking) ? agent.thinking : undefined;

  if (agent.model) {
    return { targets: [{ ref: agent.model, thinking }] };
  }

  const role = agent.role ?? DEFAULT_SUBAGENT_ROLE;
  if (chain.length === 0) {
    // An explicitly named role that does not resolve is a config error; the default
    // role is optional, so a machine without it still runs agents on pi's defaults.
    if (agent.role) {
      return {
        targets: [],
        role: agent.role,
        error: `Role "${agent.role}" has no available models. Check roles.json.`,
      };
    }
    return { targets: [] };
  }

  return {
    role,
    targets: chain.map((entry) => ({ ref: entry.ref, thinking: thinking ?? entry.thinking })),
  };
}
