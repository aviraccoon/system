/**
 * The project's policy file as the guard sees it: stat-gated, re-read only when
 * the file changes, with `changed` telling the caller to drop cached verdicts.
 *
 * The file system is injected so the refresh ordering is testable without an
 * ExtensionAPI: a stale verdict surviving a policy edit is a wrong answer in the
 * safe direction, and it is the one failure a reader cannot see.
 */

import type { EnvPolicy } from "../shared/env-policy";
import { parsePolicyFile } from "./policy-file";

export interface LoadedPolicy {
  path: string;
  policy: EnvPolicy | null;
  errors: string[];
  /** True when this load differs from the last one, so caches must clear. */
  changed: boolean;
}

export interface PolicySourceDeps {
  pathFor(cwd: string): string;
  stat(path: string): { mtimeMs: number } | null;
  read(path: string): string;
}

export interface PolicySource {
  load(cwd: string): LoadedPolicy;
}

export function createPolicySource(deps: PolicySourceDeps): PolicySource {
  let path = "";
  /** null means the file was absent at the last load. */
  let mtime: number | null = null;
  let policy: EnvPolicy | null = null;
  let errors: string[] = [];
  let pathChanged = false;

  return {
    load(cwd: string): LoadedPolicy {
      const next = deps.pathFor(cwd);
      if (next !== path) {
        path = next;
        mtime = null;
        policy = null;
        errors = [];
        pathChanged = true;
      }
      let stat: { mtimeMs: number } | null;
      try {
        stat = deps.stat(next);
      } catch {
        stat = null;
      }
      const nextMtime = stat === null ? null : stat.mtimeMs;
      if (!pathChanged && nextMtime === mtime) return { path, policy, errors, changed: false };
      pathChanged = false;

      mtime = nextMtime;
      let raw: string | null = null;
      if (stat !== null) {
        try {
          raw = deps.read(next);
        } catch (err) {
          policy = null;
          errors = [`unreadable: ${err instanceof Error ? err.message : String(err)}`];
          return { path, policy, errors, changed: true };
        }
      }
      if (raw === null) {
        policy = null;
        errors = [];
        return { path, policy, errors, changed: true };
      }
      const parsed = parsePolicyFile(raw);
      policy = parsed.policy;
      errors = parsed.errors;
      return { path, policy, errors, changed: true };
    },
  };
}
