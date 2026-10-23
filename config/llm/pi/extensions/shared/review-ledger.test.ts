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
  setOverride,
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
    message: "feat(example): add a thing",
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

  test("pruning honors the whole-file cap with the newest entries", () => {
    const a = entry({ repo: "/tmp/a", tree: "1".repeat(40), reviewedAt: "2026-10-23T12:00:00.000Z" });
    const b = entry({ repo: "/tmp/b", tree: "2".repeat(40), reviewedAt: "2026-10-23T12:01:00.000Z" });
    const c = entry({ repo: "/tmp/c", tree: "3".repeat(40), reviewedAt: "2026-10-23T12:02:00.000Z" });
    const ledger = {
      version: 1 as const,
      entries: {
        [reviewKey(a.repo, a.tree)]: a,
        [reviewKey(b.repo, b.tree)]: b,
        [reviewKey(c.repo, c.tree)]: c,
      },
    };
    const pruned = pruneLedger(ledger, { now: Date.parse("2026-10-23T12:03:00.000Z"), maxEntries: 2 });
    expect(Object.keys(pruned.entries)).toHaveLength(2);
    expect(pruned.entries[reviewKey("/tmp/c", c.tree)]).toBeDefined();
    expect(pruned.entries[reviewKey("/tmp/b", b.tree)]).toBeDefined();
    expect(pruned.entries[reviewKey("/tmp/a", a.tree)]).toBeUndefined();
  });

  test("an override authorizes a tree that no round reviewed", () => {
    const path = ledgerPath();
    setOverride(
      path,
      { repo: "/tmp/example", tree: "a".repeat(40), reason: "reviewer finding was wrong", now: new Date(NOW) },
      { now: NOW },
    );
    const stored = lookupReview(path, "/tmp/example", "a".repeat(40));
    expect(stored?.override?.reason).toBe("reviewer finding was wrong");
    // The verdict stays blocking: the override, not a verdict, is the authorization.
    expect(stored?.verdict.blocking).toBe(true);
  });

  test("an override keeps the verdict it was placed on", () => {
    const path = ledgerPath();
    recordReview(
      path,
      entry({ verdict: { blocking: true, reasons: ["severity 0.96 ≥ 0.85"], probabilities: { severity: 0.96 } } }),
      { now: NOW },
    );
    setOverride(
      path,
      { repo: "/tmp/example", tree: "a".repeat(40), reason: "quoted, not a finding", now: new Date(NOW) },
      { now: NOW },
    );
    const stored = lookupReview(path, "/tmp/example", "a".repeat(40));
    expect(stored?.verdict.reasons).toEqual(["severity 0.96 ≥ 0.85"]);
    expect(stored?.message).toBe("feat(example): add a thing");
    expect(stored?.override?.reason).toBe("quoted, not a finding");
  });

  test("a later round for the overridden tree keeps the override", () => {
    const path = ledgerPath();
    setOverride(
      path,
      { repo: "/tmp/example", tree: "a".repeat(40), reason: "fixed instead", now: new Date(NOW) },
      { now: NOW },
    );
    recordReview(path, entry({ reviewedAt: "2026-10-23T12:05:00.000Z" }), { now: NOW });
    expect(lookupReview(path, "/tmp/example", "a".repeat(40))?.override?.reason).toBe("fixed instead");
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
