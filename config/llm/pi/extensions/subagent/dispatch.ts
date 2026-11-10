/**
 * The pre-spawn dispatch decision: which mode runs, which agent configs the run
 * searches, and whether a repo agent still needs its confirmation.
 *
 * Pure. Every refusal and every plan is testable without spawning a child, which
 * is where the policy about what a dispatch may run lives.
 */

import { type AgentConfig, type AgentDirs, workerAgent } from "./agents";
import { resolveMode, specDispatchError, type TaskSpec } from "./mode";
import { type RepoGate, repoGate } from "./repo-gate";

export interface DispatchParams {
  agent?: string;
  task?: string;
  spec?: unknown;
  tasks?: TaskSpec[];
  chain?: TaskSpec[];
  cwd?: string;
  agentScope?: "user" | "project" | "both";
}

export interface DispatchFacts {
  /** Discovery result before the trust filter: the repo gate judges repo files on it. */
  discovered: AgentConfig[];
  /** Discovery result after the trust filter: what a run looks names up in. */
  agents: AgentConfig[];
  agentScope: "user" | "project" | "both";
  trusted: boolean;
  hasUI: boolean;
  accepted: (root: string) => boolean;
  projectDirs: AgentDirs;
  cwd: string;
}

export type DispatchPlan =
  | { kind: "refuse"; text: string; mode?: "single" | "parallel" | "chain" }
  | {
      kind: "run";
      mode: "single" | "parallel" | "chain";
      /** What the run searches for its agent: the discovered list, or just the worker. */
      runAgents: AgentConfig[];
      parallelTasks?: TaskSpec[];
      singleAgent?: string;
      singleTask?: string;
      singleCwd?: string;
      /** Set when a requested repo agent needs the once-per-repository confirmation. */
      confirm?: Extract<RepoGate, { kind: "confirm" }>;
    };

/**
 * Decide what a dispatch runs, or why it cannot run. A worker is single mode and
 * skips the repo gate, because it runs the dispatch's own instructions rather
 * than a repo file.
 */
export function planDispatch(params: DispatchParams, facts: DispatchFacts): DispatchPlan {
  const worker = params.spec === undefined ? undefined : workerAgent(params.spec);
  if (worker && "error" in worker) {
    return { kind: "refuse", text: `Invalid spec: ${worker.error}`, mode: "single" };
  }

  const specError = worker ? specDispatchError(params) : null;
  if (specError) return { kind: "refuse", text: `Invalid parameters. ${specError}`, mode: "single" };

  // A spec call never yields a lone task: a non-empty `agent`/`tasks`/`chain` is
  // refused, and an empty one has no item to collapse, so resolveMode already
  // returns the dispatch's own task and cwd; only the name is overridden.
  const { parallelTasks, singleAgent: resolvedAgent, singleTask, singleCwd } = resolveMode(params);
  const runAgents = worker ? [worker.agent] : facts.agents;
  const singleAgent = worker ? worker.agent.name : resolvedAgent;

  const hasChain = (params.chain?.length ?? 0) > 0;
  const hasTasks = (parallelTasks?.length ?? 0) > 0;
  const hasSingle = Boolean(singleAgent && singleTask);
  const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
  const mode = hasChain ? "chain" : hasTasks ? "parallel" : ("single" as const);

  if (modeCount !== 1) {
    const available = facts.agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
    return {
      kind: "refuse",
      text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
      mode: "single",
    };
  }

  const requestedNames = new Set<string>();
  if (params.chain) for (const step of params.chain) requestedNames.add(step.agent);
  if (parallelTasks) for (const t of parallelTasks) requestedNames.add(t.agent);
  if (singleAgent) requestedNames.add(singleAgent);

  // A worker runs the dispatch's own instructions, not a repo file, so the gate
  // (untrusted block, once-per-repo confirmation) has nothing to judge.
  const gate: RepoGate = worker
    ? { kind: "pass" }
    : repoGate({
        discovered: facts.discovered,
        requestedNames,
        agentScope: facts.agentScope,
        trusted: facts.trusted,
        hasUI: facts.hasUI,
        accepted: facts.accepted,
        projectDirs: facts.projectDirs,
      });

  // Repo agents are repo-controlled; pi's project trust is the floor.
  if (gate.kind === "block") {
    return {
      kind: "refuse",
      text: `Repo agents are disabled: project trust is not granted for ${facts.cwd}. Blocked: ${gate.names.join(", ")}. Grant trust with /trust, then restart pi and re-dispatch.`,
      mode,
    };
  }

  return {
    kind: "run",
    mode,
    runAgents,
    parallelTasks,
    singleAgent,
    singleTask,
    singleCwd,
    ...(gate.kind === "confirm" ? { confirm: gate } : {}),
  };
}
