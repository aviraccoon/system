/**
 * Git plumbing the gate needs.
 *
 * Every function throws with git's stderr rather than returning a sentinel: a
 * caller that cannot read the tree must fail closed, and it is the caller's
 * decision (note, no entry) rather than a silent empty string here.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTilde } from "../shared/paths";

/** Where `modules/home-manager/git.nix` points `core.hooksPath`. */
export const GATE_HOOKS_PATH = join(homedir(), ".config", "git", "hooks");

/** Optional locks are off: a gate read must not race the index it reads. */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
}

export function git(args: string[], cwd: string, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: gitEnv(),
    input: input ?? "",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** The worktree root, or null when the directory is not in a repository. */
export function repoToplevel(cwd: string): string | null {
  try {
    const out = git(["rev-parse", "--show-toplevel"], cwd).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** The staged tree the commit would record. Throws on an unmerged index. */
export function writeTree(cwd: string): string {
  const out = git(["write-tree"], cwd).trim();
  if (!out) throw new Error("git write-tree returned nothing");
  return out;
}

/**
 * The reviewed message and the committed message must compare equal. Both sides
 * normalize with plain `stripspace` (edge blanks and runs of blank lines), so
 * a comment line is compared as written: `commit-msg` never sees the message
 * git finally records, and the backstop reads the commit object, where git has
 * already applied whatever cleanup mode the commit used.
 */
export function normalizeMessage(message: string, cwd: string): string {
  return git(["stripspace"], cwd, message).trimEnd();
}

/** A repository-local hooks path shadows the global gate: any non-empty value. */
export function localHooksPath(cwd: string): string | null {
  try {
    const out = git(["config", "--local", "--get", "core.hooksPath"], cwd).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** The effective hooks path (local over global), or null when unset. */
export function hooksPath(cwd: string): string | null {
  try {
    const out = git(["config", "--get", "core.hooksPath"], cwd).trim();
    return out || null;
  } catch {
    return null;
  }
}

export { expandTilde } from "../shared/paths";

/**
 * Hooks a repository ships itself. A global `core.hooksPath` shadows them, so
 * the gate chains them back in; a worktree's hooks live in the common dir.
 * Only executable files are hooks, and `.sample` files are git's templates.
 */
export interface RepoHook {
  name: string;
  path: string;
  sha256: string;
}

export function repoHooks(cwd: string): RepoHook[] {
  const common = git(["rev-parse", "--git-common-dir"], cwd).trim();
  const dir = resolve(cwd, common, "hooks");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const hooks: RepoHook[] = [];
  for (const name of names.sort()) {
    if (name.endsWith(".sample")) continue;
    const path = join(dir, name);
    try {
      // Only an executable file is something git would run as a hook.
      if ((statSync(path).mode & 0o111) === 0) continue;
      hooks.push({ name, path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    } catch {
      // An unreadable entry cannot be trusted either; leave it out of the list.
    }
  }
  return hooks;
}

/**
 * Why the gate's hooks will not run for this repository, or null when they
 * will. A repository-local hooks path shadows the global one entirely, and an
 * unset global path means the nix switch has not installed the gate yet.
 */
export function hooksInactiveReason(cwd: string): string | null {
  const effective = hooksPath(cwd);
  if (!effective) return "core.hooksPath is unset";
  if (resolve(cwd, expandTilde(effective)) === resolve(GATE_HOOKS_PATH)) return null;
  return localHooksPath(cwd) ? `this repo sets core.hooksPath=${effective}` : `core.hooksPath=${effective}`;
}
