/**
 * The review ledger: which tree each reviewer round covered, and what it said.
 *
 * Keyed by the repository and the git tree object, because the tree is exactly
 * what a commit records. A review of a different tree — one edit later — does
 * not authorize the commit. The gate fails closed: a missing or unreadable
 * ledger reads as "no review", never as clean.
 *
 * The parent extension writes it (the reviewer's shell is confined and cannot);
 * the git hooks only read it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ReviewVerdictRecord {
  blocking: boolean;
  reasons: string[];
  probabilities: Record<string, number>;
}

export interface ReviewLedgerEntry {
  /** Absolute repository path (the worktree root). */
  repo: string;
  /** git tree object the reviewer saw. */
  tree: string;
  /** The proposed commit message, normalized with `git stripspace -s`. */
  message: string;
  /** ISO timestamp of the round. */
  reviewedAt: string;
  sessionId?: string;
  model?: string;
  verdict: ReviewVerdictRecord;
}

export interface ReviewLedgerFile {
  version: 1;
  entries: Record<string, ReviewLedgerEntry>;
}

export interface PruneOptions {
  now?: number;
  maxAgeDays?: number;
  maxPerRepo?: number;
  /** Whole-file cap, so many repositories cannot grow the file without bound. */
  maxEntries?: number;
}

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_PER_REPO = 50;
const DEFAULT_MAX_ENTRIES = 500;

export function reviewKey(repo: string, tree: string): string {
  // A NUL cannot appear in either path or object id, so it cannot merge two keys.
  return `${repo}\u0000${tree}`;
}

/** A missing or unreadable ledger is empty: the caller then blocks for lack of an entry. */
export function loadLedger(path: string): ReviewLedgerFile {
  if (!existsSync(path)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReviewLedgerFile>;
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveLedger(path: string, ledger: ReviewLedgerFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function pruneLedger(ledger: ReviewLedgerFile, options: PruneOptions = {}): ReviewLedgerFile {
  const now = options.now ?? Date.now();
  const maxAgeMs = (options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
  const maxPerRepo = options.maxPerRepo ?? DEFAULT_MAX_PER_REPO;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const kept: ReviewLedgerEntry[] = [];
  const byRepo = new Map<string, ReviewLedgerEntry[]>();
  for (const entry of Object.values(ledger.entries)) {
    const age = now - Date.parse(entry.reviewedAt);
    if (!Number.isFinite(age) || age > maxAgeMs) continue;
    const list = byRepo.get(entry.repo) ?? [];
    list.push(entry);
    byRepo.set(entry.repo, list);
  }
  for (const entries of byRepo.values()) {
    for (const entry of entries
      .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))
      .slice(0, maxPerRepo)) {
      kept.push(entry);
    }
  }
  const out: Record<string, ReviewLedgerEntry> = {};
  kept
    .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))
    .slice(0, maxEntries)
    .forEach((entry) => {
      out[reviewKey(entry.repo, entry.tree)] = entry;
    });
  return { version: 1, entries: out };
}

/**
 * Record one round. A later round for the same tree replaces the earlier verdict.
 * Single-writer: load and save are synchronous, so parallel rounds in one
 * process cannot interleave, but a second pi process can drop an entry. The
 * loss fails closed (the commit finds no review), never open.
 */
export function recordReview(path: string, entry: ReviewLedgerEntry, options: PruneOptions = {}): ReviewLedgerFile {
  const ledger = loadLedger(path);
  ledger.entries[reviewKey(entry.repo, entry.tree)] = entry;
  const pruned = pruneLedger(ledger, options);
  saveLedger(path, pruned);
  return pruned;
}

/** The reviewed tree, or undefined. The caller must treat undefined as blocked. */
export function lookupReview(path: string, repo: string, tree: string): ReviewLedgerEntry | undefined {
  return loadLedger(path).entries[reviewKey(repo, tree)];
}
