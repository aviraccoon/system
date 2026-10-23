/**
 * Synthetic cases for the review-verdict question.
 *
 * Every case is written from scratch. No session, journal, or repository text
 * is copied into this file: the benchmark must stay runnable on a clean clone.
 *
 * `expected` is the gate's reading of the report: true means the report blocks
 * the commit (an unresolved, in-scope CRITICAL/MAJOR, a behavior finding, or an
 * unfinished review). A NIT/MINOR prose finding, an out-of-scope finding, and a
 * resolved finding that a later round quotes are all non-blocking.
 */

import type { TestCase } from "./shared";

export type VerdictGroup = "clean" | "nit" | "blocking" | "quoted" | "out-of-scope" | "behavior" | "incomplete";

export interface VerdictCase extends TestCase<boolean> {
  id: string;
  /** The reviewer report, in the shape the agent writes it. */
  input: string;
  group: VerdictGroup;
  /** True when the report should block the commit. */
  expected: boolean;
}

export const VERDICT_CASES: VerdictCase[] = [
  {
    id: "clean-plain",
    group: "clean",
    expected: false,
    input: [
      "## Findings",
      "",
      "No findings. I read the staged diff, the two call sites, and the test that pins the retry path.",
      "The empty-list case returns the same value as before, and the new branch cannot run without a key.",
    ].join("\n"),
  },
  {
    id: "clean-short",
    group: "clean",
    expected: false,
    input: "Clean. Read `src/billing/invoice.ts` and `src/billing/invoice.test.ts`; nothing to report.",
  },
  {
    id: "clean-with-gaps",
    group: "clean",
    expected: false,
    input: [
      "## Findings",
      "",
      "No findings.",
      "",
      "Could not verify: the live webhook path is outside this sandbox, so the retry against a real",
      "endpoint is unverified. Recorded here rather than inferred.",
    ].join("\n"),
  },
  {
    id: "nit-two",
    group: "nit",
    expected: false,
    input: [
      "## Findings",
      "",
      "**NIT** — `src/queue/worker.ts`, the loop",
      "- **what**: `item` shadows the outer `entry` name.",
      "- **fix**: rename it.",
      "",
      "**NIT** — `README.md`, second paragraph",
      "- **what**: one sentence repeats the sentence above it.",
    ].join("\n"),
  },
  {
    id: "nit-clean",
    group: "nit",
    expected: false,
    input:
      "## Findings\n\n**NIT** — `src/queue/worker.ts`: the comment says `milliseconds`, the value is seconds. Otherwise clean.",
  },
  {
    id: "minor-prose",
    group: "nit",
    expected: false,
    input: [
      "## Findings",
      "",
      "**MINOR** — `docs/invoices.md`, the retry section",
      '- **what**: the paragraph calls the backoff "fixed" while the code doubles it.',
      "- **why**: a reader following the doc configures the wrong delay. No code changes behavior.",
      '- **fix**: say "doubling".',
    ].join("\n"),
  },
  {
    id: "major-null",
    group: "blocking",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MAJOR** — `src/billing/invoice.ts`, `load()`",
      "- **where**: `const value = cache.get(key); return value.length;`",
      "- **what**: the new branch returns before the cache is populated, so `value` is `undefined` and",
      "  `value.length` throws on the first call after a restart.",
      "- **why**: a cold start always takes that path; the test seeds the cache first, so it misses it.",
      "- **fix**: return `undefined` when the cache misses, and add a cold-start test.",
    ].join("\n"),
  },
  {
    id: "critical-injection",
    group: "blocking",
    expected: true,
    input: [
      "## Findings",
      "",
      "**CRITICAL** — `src/api/users.ts`, `findUser()`",
      '- **where**: `db.query("select * from users where id = \'" + id + "\'")`',
      "- **what**: `id` reaches SQL by concatenation; a quote in the parameter changes the statement.",
      "- **why**: the route that calls this accepts the value from a query string.",
      "- **fix**: use the parameterized form the other queries use.",
    ].join("\n"),
  },
  {
    id: "major-message",
    group: "blocking",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MAJOR** — the proposed commit message",
      '- **what**: the subject says the change "removes the legacy loader", but the diff only adds a',
      "  second path next to it. No hunk removes or renames the loader.",
      "- **why**: a reader of the commit cannot check the central claim against the tree.",
      "- **fix**: describe what the diff does.",
    ].join("\n"),
  },
  {
    id: "major-test-mirror",
    group: "blocking",
    expected: true,
    input: [
      "## Findings",
      "",
      '**MAJOR** — `src/billing/invoice.test.ts`, "formats the value"',
      "- **what**: the expected value is a copy of the literal in `format()`, so the test would pass with",
      "  the production code deleted and the literal pasted into the test.",
      "- **why**: the assertion mirrors the implementation instead of exercising it; any real regression",
      "  in the formatting path is invisible.",
      "- **fix**: assert a property of the output, or move the literal to the boundary that owns it.",
    ].join("\n"),
  },
  {
    id: "quoted-resolved-critical",
    group: "quoted",
    expected: false,
    input: [
      "## Findings",
      "",
      "Round 3's **CRITICAL** — the concatenated SQL in `findUser()` — is fixed: the query now uses the",
      "parameterized form and the new test passes a quote through it. I re-read the call site.",
      "",
      "No findings this round.",
    ].join("\n"),
  },
  {
    id: "quoted-resolved-major",
    group: "quoted",
    expected: false,
    input: [
      "## Findings",
      "",
      "The previous **MAJOR** (the missing null check on the cache miss) is resolved; the branch now",
      "returns early.",
      "",
      "The delta introduces no new finding. NIT only: the new comment repeats the function name.",
    ].join("\n"),
  },
  {
    id: "out-of-scope-major",
    group: "out-of-scope",
    expected: false,
    input: [
      "## Findings",
      "",
      "**MAJOR** — `src/legacy/migrate.ts`, `migrate()`",
      "- **what**: the migration is not idempotent.",
      "- **why**: it is pre-existing code this change does not touch, so it is out of scope for this review.",
      "- **note**: filed for a separate change; no hunk here reaches it.",
    ].join("\n"),
  },
  {
    id: "declined-minor",
    group: "nit",
    expected: false,
    input: [
      "## Findings",
      "",
      "**MINOR** — `src/billing/invoice.ts`, an unused branch",
      "- **what**: the branch cannot be reached from the changed path.",
      "- **why**: it predates this change and touching it would widen the diff; declined for this commit.",
      "",
      "Nothing in the changed lines needs another round.",
    ].join("\n"),
  },
  {
    id: "declined-major",
    group: "blocking",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MAJOR** — `src/billing/invoice.ts`, `load()`: the cache miss still reaches `value.length`.",
      "- **why**: the fix would widen this change; declined for this commit.",
    ].join("\n"),
  },
  {
    id: "wrong-result-minor",
    group: "behavior",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MINOR** — `src/billing/totals.ts`, `slugify()`",
      '- **what**: a trailing digit is dropped — `"invoice2"` becomes `"invoice"`.',
      "- **why**: the function is new in this change, so there is no earlier behavior to compare, and",
      "  no test covers the digit case. The result is wrong for every caller that keeps IDs.",
      "- **fix**: keep the digits, and add a case for them.",
    ].join("\n"),
  },
  {
    id: "behavior-minor",
    group: "behavior",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MINOR** — `src/queue/worker.ts`, `format()`",
      "- **what**: on an empty input the function now returns `null` instead of throwing.",
      "- **why**: the severity is low but the contract changed; every caller that checks the return value",
      "  behaves differently, and the test still expects the throw.",
      "- **fix**: restore the throw, or update the callers and the test in this change.",
    ].join("\n"),
  },
  {
    id: "behavior-ordering",
    group: "behavior",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MINOR** — `src/queue/flush.ts`, the flush loop",
      "- **what**: the loop now drains the queue in insertion order instead of reverse order.",
      "- **why**: the visible behavior changes for every consumer; two handlers rely on the old order.",
      "- **fix**: keep the old order, or make the new order explicit in the change.",
    ].join("\n"),
  },
  {
    id: "incomplete-budget",
    group: "incomplete",
    expected: true,
    input: [
      "## Findings",
      "",
      "No findings in the first half of the diff.",
      "",
      "I ran out of budget before reading the second half, so the migration and the CI file are",
      "unreviewed. This round did not finish.",
    ].join("\n"),
  },
  {
    id: "unread-changed-file",
    group: "incomplete",
    expected: true,
    input: [
      "## Findings",
      "",
      "The change looks clean. I could not read `src/queue/worker.test.ts`, which is in this diff — the",
      "shell refused the path — so the new test is unverified and that part of the change is unreviewed.",
    ].join("\n"),
  },
  {
    id: "clean-only-nit-in-passing",
    group: "clean",
    expected: false,
    input: [
      "## Findings",
      "",
      "No blocking findings. One NIT: `src/billing/invoice.ts` reuses the name `data` for both the request and the",
      "response; rename the second one when convenient.",
    ].join("\n"),
  },
  {
    id: "behavior-pinned",
    group: "behavior",
    expected: false,
    input: [
      "## Findings",
      "",
      "**MINOR** — `src/queue/worker.ts`, `format()`",
      '- **what**: an empty input now returns `null` instead of `""`.',
      "- **why**: the behavior change is deliberate, and the new test `returns null for an empty list`",
      "  pins it; the test would fail if the branch were removed.",
      "- **fix**: none required for this change.",
    ].join("\n"),
  },
  {
    id: "behavior-no-pin",
    group: "behavior",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MINOR** — `src/queue/worker.ts`, `format()`",
      '- **what**: an empty input now returns `null` instead of `""`.',
      "- **why**: no test covers the empty input, so the change is unpinned and every caller that",
      '  compares against `""` behaves differently.',
      "- **fix**: add a test for the empty input, or keep the old value.",
    ].join("\n"),
  },
  {
    id: "nit-behavior",
    group: "behavior",
    expected: true,
    input: [
      "## Findings",
      "",
      "**NIT** — `src/queue/flush.ts`",
      "- **what**: the loop order flipped; handlers now see the last item first.",
      "- **why**: graded NIT because the fix is small, but the observable order changes with no test",
      "  covering it.",
      "- **fix**: restore the old order, or pin the new one.",
    ].join("\n"),
  },
  {
    id: "severity-in-code-quote",
    group: "clean",
    expected: false,
    input: [
      "## Findings",
      "",
      "No findings. One pre-existing comment in `src/queue/worker.ts` says `// CRITICAL: fix before release`;",
      "it is prose in the file, not a finding about this diff.",
    ].join("\n"),
  },
  {
    id: "contradiction",
    group: "blocking",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MAJOR** — `src/billing/invoice.ts`, `load()`: the cache miss still reaches `value.length`.",
      "",
      "No findings this round.",
    ].join("\n"),
  },
  {
    id: "unfinished-partial",
    group: "incomplete",
    expected: true,
    input: [
      "## Findings",
      "",
      "I read the first eight of fourteen changed files; the rest is unreviewed.",
      "What I read is clean.",
    ].join("\n"),
  },
  {
    id: "dispatch-gap",
    group: "blocking",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MAJOR** — the dispatch carried no proposed commit message, so the message that will ship has",
      "never been reviewed.",
      "- **fix**: add the proposed message and re-dispatch.",
    ].join("\n"),
  },
  {
    id: "out-of-scope-critical",
    group: "out-of-scope",
    expected: false,
    input: [
      "## Findings",
      "",
      "**CRITICAL** — `src/legacy/migrate.ts`: the migration is not idempotent.",
      "- **why**: this file predates the change and no hunk touches it; it is not part of this diff.",
    ].join("\n"),
  },
  {
    id: "intended-behavior-no-pin",
    group: "behavior",
    expected: true,
    input: [
      "## Findings",
      "",
      '**MINOR** — `src/queue/worker.ts`: an empty input now returns `null` instead of `""`.',
      "- **why**: the change is intentional and documented, but no test asserts the new value, so the",
      "  behavior can change again unseen.",
      "- **fix**: add a test for the empty input.",
    ].join("\n"),
  },
  {
    id: "minor-test-gap",
    group: "nit",
    expected: false,
    input: [
      "## Findings",
      "",
      "**MINOR** — `src/queue/worker.ts`: the existing retry path has no test at all.",
      "- **why**: behavior is unchanged by this diff; this is a pre-existing gap, not introduced here.",
    ].join("\n"),
  },
  {
    id: "empty-report",
    group: "incomplete",
    expected: true,
    input: "",
  },
  {
    id: "truncated-report",
    group: "incomplete",
    expected: true,
    input: [
      "## Findings",
      "",
      "**MAJOR** — `src/api/users.ts`, `findUser()`: the query is built by concatenation and the",
    ].join("\n"),
  },
  {
    id: "quoted-plus-nit",
    group: "quoted",
    expected: false,
    input: [
      "## Findings",
      "",
      "Round 2's **MAJOR** (the missing null check) is fixed and pinned by the new cold-start test.",
      "One NIT: the new comment repeats the function name.",
    ].join("\n"),
  },
  {
    id: "out-of-scope-plus-nit",
    group: "out-of-scope",
    expected: false,
    input: [
      "## Findings",
      "",
      "**MAJOR** — `src/legacy/migrate.ts`: not idempotent; pre-existing and untouched by this diff.",
      "**NIT** — `src/billing/invoice.ts`: a local shadows the outer `entry` name.",
    ].join("\n"),
  },
];

export interface VerdictRow {
  id: string;
  group: VerdictGroup;
  expected: boolean;
  /** The gate's decision at the configured per-question thresholds. */
  blocking?: boolean;
  /** Highest per-question probability; null when any question failed to answer. */
  pBlocking: number | null;
  /** Per-question probabilities, so a run names the condition that fired. */
  scores?: Record<string, number | null>;
  ms: number;
  cost: number;
  error?: string;
}

export interface ThresholdScore {
  threshold: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  errors: number;
  /** Clean reports blocked: the cost that stops commits. */
  falseBlock: number;
  /** Blocking reports passed: the failure the gate exists to prevent. */
  falsePass: number;
  total: number;
}

/** A failed model call blocks, matching the gate's fail-closed policy. */
export function isBlocked(row: Pick<VerdictRow, "pBlocking">, threshold: number): boolean {
  return row.pBlocking === null || row.pBlocking >= threshold;
}

export function passes(row: Pick<VerdictRow, "expected" | "pBlocking" | "blocking">, threshold: number): boolean {
  return (row.blocking ?? isBlocked(row, threshold)) === row.expected;
}

function scoreRows(rows: VerdictRow[], threshold: number, useStored: boolean): ThresholdScore {
  const score: ThresholdScore = {
    threshold,
    truePositive: 0,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
    errors: 0,
    falseBlock: 0,
    falsePass: 0,
    total: rows.length,
  };
  for (const row of rows) {
    if (row.pBlocking === null) {
      score.errors += 1;
      continue;
    }
    const blocked = useStored && row.blocking !== undefined ? row.blocking : isBlocked(row, threshold);
    if (row.expected && blocked) score.truePositive += 1;
    else if (row.expected) score.falseNegative += 1;
    else if (blocked) score.falsePositive += 1;
    else score.trueNegative += 1;
  }
  score.falseBlock = score.falsePositive;
  score.falsePass = score.falseNegative;
  return score;
}

export function scoreAt(rows: VerdictRow[], threshold: number): ThresholdScore {
  return scoreRows(rows, threshold, true);
}

/** Thresholds from 0.50 to 0.95 in 0.05 steps. */
export function sweep(rows: VerdictRow[]): ThresholdScore[] {
  return Array.from({ length: 10 }, (_, index) => scoreRows(rows, Number((0.5 + index * 0.05).toFixed(2)), false));
}
