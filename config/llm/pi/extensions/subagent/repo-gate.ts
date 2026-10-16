/**
 * Repo-agent dispatch policy: block when the project is untrusted, confirm
 * once per repository per session, otherwise pass. Pure — the caller runs the
 * dialog and writes the session entry.
 */

import { type AgentConfig, type AgentDirs, projectRootOf } from "./agents";

export type RepoGate =
  | { kind: "pass" }
  | { kind: "block"; names: string[] }
  | { kind: "confirm"; names: string[]; dirs: string[]; root: string | null };

export interface RepoGateInput {
  /** Discovery result, before the trust filter. */
  discovered: AgentConfig[];
  requestedNames: Iterable<string>;
  agentScope: "user" | "project" | "both";
  trusted: boolean;
  hasUI: boolean;
  /** Whether this session already accepted the repo root. */
  accepted: (root: string) => boolean;
  projectDirs: AgentDirs;
}

export function repoGate(input: RepoGateInput): RepoGate {
  const requested = new Set(input.requestedNames);

  if (!input.trusted) {
    const names = input.discovered.filter((a) => a.source === "project" && requested.has(a.name)).map((a) => a.name);
    return names.length > 0 ? { kind: "block", names } : { kind: "pass" };
  }

  if (input.agentScope === "user" || !input.hasUI) return { kind: "pass" };

  const repoAgents = input.discovered.filter((a) => a.source === "project" && requested.has(a.name));
  if (repoAgents.length === 0) return { kind: "pass" };

  const root = projectRootOf(input.projectDirs);
  if (root !== null && input.accepted(root)) return { kind: "pass" };

  const dirs = [input.projectDirs.neutral, input.projectDirs.pi].filter((d): d is string => d !== null);
  return { kind: "confirm", names: repoAgents.map((a) => a.name), dirs, root };
}
