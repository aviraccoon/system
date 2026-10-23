/**
 * Git plumbing the gate needs.
 *
 * Every function throws with git's stderr rather than returning a sentinel: a
 * caller that cannot read the tree must fail closed, and it is the caller's
 * decision (note, no entry) rather than a silent empty string here.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
 * The reviewed message and the committed message must compare equal, so both
 * sides normalize with this, and the comparison cannot drift. `stripspace -s`
 * drops comment lines and blank edges; `git commit -m` uses a weaker cleanup
 * that keeps a `#` line, which is why `hasCommentLines` refuses one.
 */
export function normalizeMessage(message: string, cwd: string): string {
  return git(["stripspace", "-s"], cwd, message).trimEnd();
}

/**
 * True when `stripspace -s` would drop a line that `git commit -m` keeps: a
 * `#`-prefixed line. Normalizing both sides would compare the message without
 * it while the commit ships it, so the tool refuses such a message.
 */
export function hasCommentLines(message: string, cwd: string): boolean {
  return git(["stripspace"], cwd, message).trimEnd() !== git(["stripspace", "-s"], cwd, message).trimEnd();
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

/** Git expands a leading `~/` itself; `path.resolve` does not. */
export function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
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
