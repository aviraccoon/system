// Git-aware scanning for targets with `gitignore = true`: find the repos in a
// tree, then ask git which paths each one ignores. Git resolves nested
// .gitignore files, negations and `**` itself, so the rules raccache writes
// match what git would track.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { RepoIgnores } from "./filters";

// Regenerable directories a walk never needs to look inside. Repos nested
// under them are either generated checkouts or ignored by their parent repo.
export const DEFAULT_PRUNE = [
  "node_modules",
  ".pnpm-store",
  ".yarn",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".venv",
  "venv",
  ".direnv",
  "Pods",
  ".build",
  "DerivedData",
  "SourcePackages",
  "vendor",
  "__pycache__",
  ".gradle",
  ".terraform",
];

export const DEFAULT_MAX_DEPTH = 4;

/** Repository directories under `root`, deepest-last per level, sorted. */
export function discoverRepos(root: string, options: { maxDepth?: number; prune?: string[] } = {}): string[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const prune = new Set([...DEFAULT_PRUNE, ...(options.prune ?? [])]);
  const repos: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop() as { dir: string; depth: number };
    const entries = (() => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return null; // unreadable directory: skip it, not the whole target
      }
    })();
    if (!entries) continue;
    if (entries.some((entry) => entry.name === ".git")) repos.push(dir);
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === ".git" || prune.has(entry.name)) continue;
      stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }
  return repos.sort();
}

/** `git ls-files --ignored --others --exclude-standard --directory` in one repo. */
export function readRepoIgnores(repoDir: string, git = "git"): { entries: string[]; error?: string } {
  try {
    const out = execFileSync(
      git,
      ["-C", repoDir, "ls-files", "--ignored", "--others", "--exclude-standard", "--directory", "-z"],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    return { entries: out.split("\0").filter(Boolean) };
  } catch (error) {
    const status = (error as { status?: number | null }).status;
    const detail =
      error instanceof Error && "stderr" in error ? String((error as { stderr: unknown }).stderr).trim() : "";
    return {
      entries: [],
      error: `git ls-files failed${status === undefined ? "" : ` (exit ${status})`}${detail ? `: ${detail.split("\n")[0]}` : ""}`,
    };
  }
}

/**
 * Ignore entries for every repo under `root`, with paths relative to the
 * target root. A repo whose git call fails contributes no rules and an error:
 * missing rules over-upload, they never delete.
 */
export function collectRepoIgnores(
  root: string,
  repos: string[],
  git = "git",
): { ignores: RepoIgnores[]; errors: string[] } {
  const ignores: RepoIgnores[] = [];
  const errors: string[] = [];
  for (const repoDir of repos) {
    const rel = relative(root, repoDir);
    const repo = rel === "" || rel === "." ? "" : rel.split("\\").join("/");
    const { entries, error } = readRepoIgnores(repoDir, git);
    if (error) errors.push(`${repo || "."}: ${error}`);
    ignores.push({ repo, entries });
  }
  return { ignores, errors };
}
