/**
 * Repository exemptions from the commit gate.
 *
 * A file of absolute repository paths, written only by `/review-gate exempt`
 * (a user command) and read by the hooks. An exempt repository commits without
 * a reviewed tree; the exemption is per repository, not per tree.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RepoExemption {
  repo: string;
  at: string;
  sessionId?: string;
}

export interface ExemptionFile {
  version: 1;
  repos: RepoExemption[];
}

/** A missing or unreadable file exempts nothing. */
export function loadExemptions(path: string): ExemptionFile {
  if (!existsSync(path)) return { version: 1, repos: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ExemptionFile>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.repos)) return { version: 1, repos: [] };
    return { version: 1, repos: parsed.repos.filter((item) => typeof item?.repo === "string") };
  } catch {
    return { version: 1, repos: [] };
  }
}

function save(path: string, file: ExemptionFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function isExempt(file: ExemptionFile, repo: string): boolean {
  return file.repos.some((item) => item.repo === repo);
}

export function setExemption(path: string, entry: RepoExemption): ExemptionFile {
  const file = loadExemptions(path);
  const others = file.repos.filter((item) => item.repo !== entry.repo);
  const next: ExemptionFile = { version: 1, repos: [...others, entry] };
  save(path, next);
  return next;
}

export function removeExemption(path: string, repo: string): ExemptionFile {
  const file = loadExemptions(path);
  const next: ExemptionFile = { version: 1, repos: file.repos.filter((item) => item.repo !== repo) };
  save(path, next);
  return next;
}
