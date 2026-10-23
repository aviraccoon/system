/**
 * Review-verdict benchmark: does the classifier agree with the policy on
 * whether a reviewer report blocks a commit?
 *
 * Cases are synthetic (`verdict-cases.ts`); no session or repository text is
 * read. Three typed nouls per case, the same questions the gate asks; the
 * answers at their thresholds are the decision.
 *
 * Run:
 *   bun run benchmarks/verdict.ts
 *   VERDICT_THRESHOLD=0.85 bun run benchmarks/verdict.ts
 *   BENCH_DUMP=/tmp/verdict.jsonl bun run benchmarks/verdict.ts
 *
 * The model comes from VERDICT_MODEL or the decisions pin; VERDICT_PROVIDER
 * selects the provider and BENCH_GROUP selects case groups.
 */

import { writeFileSync } from "node:fs";
import { DEFAULT_DECISIONS_MODEL, decisionsComplete } from "../extensions/shared/decisions";
import {
  DEFAULT_VERDICT_THRESHOLDS,
  REVIEW_VERDICT_QUESTIONS,
  type VerdictThresholds,
  verdictFromAnswers,
} from "../extensions/shared/review-verdict";
import { mapWithConcurrency, resolveProviderKey, selectTests } from "./shared";
import { passes, scoreAt, sweep, VERDICT_CASES, type VerdictCase, type VerdictRow } from "./verdict-cases";

const MODEL = process.env.VERDICT_MODEL ?? DEFAULT_DECISIONS_MODEL;
const PROVIDER = process.env.VERDICT_PROVIDER ?? "openrouter";
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);
const THRESHOLD = Number(process.env.VERDICT_THRESHOLD ?? DEFAULT_VERDICT_THRESHOLDS.severity);
const thresholds: VerdictThresholds = { severity: THRESHOLD, behavior: THRESHOLD, unfinished: THRESHOLD };

async function runCase(apiKey: string, test: VerdictCase): Promise<VerdictRow> {
  const base = { id: test.id, group: test.group, expected: test.expected, pBlocking: null, ms: 0, cost: 0 };
  try {
    const result = await decisionsComplete(
      {
        model: MODEL,
        state: { reviewTarget: "the staged change", report: test.input },
        questions: REVIEW_VERDICT_QUESTIONS,
      },
      { apiKey, timeoutMs: 60_000 },
    );
    const verdict = verdictFromAnswers(result.answers, thresholds);
    const scores = Object.fromEntries(
      Object.keys(REVIEW_VERDICT_QUESTIONS).map((name) => {
        const value = result.answers[name];
        return [name, value?.type === "noul" ? value.noul : null];
      }),
    );
    return {
      ...base,
      // All three thresholds are equal in this runner, so the max is the gate's
      // decision; `blocking` stores the per-question result for the score.
      pBlocking: verdict ? Math.max(...Object.values(verdict.probabilities)) : null,
      blocking: verdict?.blocking,
      scores,
      ms: result.ms,
      cost: result.usage.cost,
      ...(verdict ? {} : { error: "a question did not answer" }),
    };
  } catch (err) {
    return { ...base, error: String(err).slice(0, 160) };
  }
}

const apiKey = resolveProviderKey(PROVIDER);
const cases = selectTests(VERDICT_CASES);
const rows = await mapWithConcurrency(cases, CONCURRENCY, (test) => runCase(apiKey, test));

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

console.log(
  `${BOLD}${MODEL} via ${PROVIDER}${RESET}  ${DIM}${cases.length} cases, threshold ${THRESHOLD}, concurrency ${CONCURRENCY}${RESET}\n`,
);
for (const row of rows) {
  const icon = passes(row, THRESHOLD) ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const p = row.pBlocking === null ? "  -  " : row.pBlocking.toFixed(2);
  const scores = Object.entries(row.scores ?? {})
    .map(([name, value]) => `${name}=${value === null ? "-" : value.toFixed(2)}`)
    .join(" ");
  console.log(`  ${icon}  ${row.group.padEnd(12)} want=${String(row.expected).padEnd(5)} p=${p}  ${scores}  ${row.id}`);
  if (row.error) console.log(`      ${DIM}${row.error}${RESET}`);
}

const at = scoreAt(rows, THRESHOLD);
console.log(
  `\n  ${BOLD}${at.truePositive + at.trueNegative}/${rows.length}${RESET}  ` +
    `${DIM}false pass ${at.falsePass}  false block ${at.falseBlock}  errors ${at.errors}${RESET}\n`,
);
console.log(`  ${BOLD}threshold  false-pass  false-block${RESET}`);
for (const row of sweep(rows)) {
  const marker = row.threshold === THRESHOLD ? "  <-" : "";
  console.log(
    `  ${row.threshold.toFixed(2)}       ${String(row.falsePass).padStart(2)}          ${String(row.falseBlock).padStart(2)}${marker}`,
  );
}

// Offline threshold sweeps without re-running the model.
const dump = process.env.BENCH_DUMP;
if (dump) {
  writeFileSync(dump, `${rows.map((row, index) => JSON.stringify({ ...row, case: cases[index] })).join("\n")}\n`);
}
