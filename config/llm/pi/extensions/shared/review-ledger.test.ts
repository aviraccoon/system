import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLedger,
  lookupReview,
  pruneLedger,
  type ReviewLedgerEntry,
  recordReview,
  reviewKey,
} from "./review-ledger";

const dirs: string[] = [];
const NOW = Date.parse("2026-10-23T12:02:00.000Z");

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-ledger-"));
  dirs.push(dir);
  return join(dir, "ledger.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<ReviewLedgerEntry> = {}): ReviewLedgerEntry {
  return {
    repo: "/tmp/example",
    tree: "a".repeat(40),
    reviewedAt: "2026-10-23T12:00:00.000Z",
    verdict: { blocking: false, reasons: [], probabilities: { severity: 0.02, behavior: 0.02, unfinished: 0.01 } },
    ...overrides,
  };
}

describe("review ledger", () => {
  test("a missing ledger has no entry", () => {
    const path = ledgerPath();
    expect(loadLedger(path)).toEqual({ version: 1, entries: {} });
    expect(lookupReview(path, "/tmp/example", "b".repeat(40))).toBeUndefined();
  });

  test("a recorded tree is found and a different tree is not", () => {
    const path = ledgerPath();
    recordReview(path, entry(), { now: NOW });
    expect(lookupReview(path, "/tmp/example", "a".repeat(40))?.verdict.blocking).toBe(false);
    expect(lookupReview(path, "/tmp/example", "b".repeat(40))).toBeUndefined();
  });

  test("a later round for the same tree replaces the verdict", () => {
    const path = ledgerPath();
    recordReview(path, entry(), { now: NOW });
    recordReview(
      path,
      entry({
        reviewedAt: "2026-10-23T12:05:00.000Z",
        verdict: { blocking: true, reasons: ["severity"], probabilities: {} },
      }),
      { now: NOW },
    );
    expect(lookupReview(path, "/tmp/example", "a".repeat(40))?.verdict.blocking).toBe(true);
  });

  test("a malformed ledger reads as empty, not as a pass", () => {
    const path = ledgerPath();
    writeFileSync(path, "{not json");
    expect(loadLedger(path).entries).toEqual({});
  });

  test("recordReview applies its prune options", () => {
    const path = ledgerPath();
    recordReview(path, entry({ tree: "1".repeat(40), reviewedAt: "2026-10-23T12:00:00.000Z" }), {
      now: NOW,
      maxPerRepo: 1,
    });
    recordReview(path, entry({ tree: "2".repeat(40), reviewedAt: "2026-10-23T12:01:00.000Z" }), {
      now: NOW,
      maxPerRepo: 1,
    });
    expect(lookupReview(path, "/tmp/example", "1".repeat(40))).toBeUndefined();
    expect(lookupReview(path, "/tmp/example", "2".repeat(40))).toBeDefined();
  });

  test("recordReview honors maxAgeDays against the supplied now", () => {
    const path = ledgerPath();
    recordReview(path, entry({ tree: "1".repeat(40), reviewedAt: "2026-10-20T12:00:00.000Z" }), {
      now: NOW,
      maxAgeDays: 1,
    });
    recordReview(path, entry({ tree: "2".repeat(40), reviewedAt: "2026-10-23T12:00:00.000Z" }), {
      now: NOW,
      maxAgeDays: 1,
    });
    expect(lookupReview(path, "/tmp/example", "1".repeat(40))).toBeUndefined();
    expect(lookupReview(path, "/tmp/example", "2".repeat(40))).toBeDefined();
  });

  test("pruning drops old entries and keeps the newest per repo", () => {
    const old = entry({ tree: "1".repeat(40), reviewedAt: "2026-01-01T00:00:00.000Z" });
    const a = entry({ repo: "/tmp/a", tree: "2".repeat(40), reviewedAt: "2026-10-23T12:00:00.000Z" });
    const b = entry({ repo: "/tmp/a", tree: "3".repeat(40), reviewedAt: "2026-10-23T12:01:00.000Z" });
    const c = entry({ repo: "/tmp/b", tree: "4".repeat(40), reviewedAt: "2026-10-23T12:02:00.000Z" });
    const ledger = {
      version: 1 as const,
      entries: {
        [reviewKey(old.repo, old.tree)]: old,
        [reviewKey(a.repo, a.tree)]: a,
        [reviewKey(b.repo, b.tree)]: b,
        [reviewKey(c.repo, c.tree)]: c,
      },
    };
    const pruned = pruneLedger(ledger, { now: Date.parse("2026-10-23T12:03:00.000Z"), maxPerRepo: 1 });
    expect(Object.keys(pruned.entries)).toHaveLength(2);
    expect(pruned.entries[reviewKey("/tmp/a", "3".repeat(40))]).toBeDefined();
    expect(pruned.entries[reviewKey("/tmp/b", "4".repeat(40))]).toBeDefined();
  });
});
