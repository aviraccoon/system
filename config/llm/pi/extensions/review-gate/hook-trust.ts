/**
 * Content-hash trust for a repository's own git hooks.
 *
 * A global `core.hooksPath` shadows the hooks a repository ships, so the gate
 * chains them back in. A repository's hook is executable code from repository
 * content, so it runs only after the user trusted that exact content: the entry
 * is keyed by repository, hook name and sha256, and a changed hook no longer
 * matches. Only `/review-gate trust-hooks` writes the file.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HookTrustEntry {
  repo: string;
  hook: string;
  sha256: string;
  at: string;
}

export interface HookTrustFile {
  version: 1;
  hooks: HookTrustEntry[];
}

/** A missing or unreadable file trusts nothing. */
export function loadHookTrust(path: string): HookTrustFile {
  if (!existsSync(path)) return { version: 1, hooks: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<HookTrustFile>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.hooks)) return { version: 1, hooks: [] };
    return {
      version: 1,
      hooks: parsed.hooks.filter(
        (item) => typeof item?.repo === "string" && typeof item?.hook === "string" && typeof item?.sha256 === "string",
      ),
    };
  } catch {
    return { version: 1, hooks: [] };
  }
}

export function hashHook(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Trust exactly the content that is on disk now. */
export function isHookTrusted(file: HookTrustFile, repo: string, hook: string, sha256: string): boolean {
  return file.hooks.some((item) => item.repo === repo && item.hook === hook && item.sha256 === sha256);
}

function save(path: string, file: HookTrustFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function trustHook(path: string, entry: HookTrustEntry): HookTrustFile {
  const file = loadHookTrust(path);
  // One entry per (repo, hook): a re-trust replaces the hash it supersedes.
  const others = file.hooks.filter((item) => !(item.repo === entry.repo && item.hook === entry.hook));
  const next: HookTrustFile = { version: 1, hooks: [...others, entry] };
  save(path, next);
  return next;
}
