/**
 * Advisory benchmark: the output-capture question over its own case group.
 *
 * Run: BENCH_SEED=run-a bun run benchmarks/advisory.ts
 *
 * One typed noul per case — no risk battery. The answer at ADVICE_BLOCK_THRESHOLD
 * is the block decision, scored against the case's expected block/allow.
 * BENCH_DUMP writes the raw noul per case for offline threshold sweeps.
 * BENCH_GROUP selects a subset (every advisory case carries the
 * `output-capture` group).
 */

import { writeFileSync } from "node:fs";
import { ADVICE_QUESTION, adviceBlocks } from "../extensions/shared/advisory";
import {
  DEFAULT_DECISIONS_MODEL,
  type DecisionsAnswer,
  type DecisionsQuestion,
  decisionsComplete,
} from "../extensions/shared/decisions";
import { type AdviceOutcome, buildAdvisoryTests } from "./advisory-cases";
import { makeFixture } from "./explain-cases";
import { fmt, mapWithConcurrency, resolveProviderKey, selectTests, type TestCase } from "./shared";

const MODEL = process.env.DECISIONS_MODEL ?? DEFAULT_DECISIONS_MODEL;
// models.json carries this provider's credential; the pi-side gate uses the
// built-in `openrouter` provider instead, whose key comes from pi's auth store.
const PROVIDER = process.env.DECISIONS_PROVIDER ?? "openrouter-sidecar";
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);

const QUESTIONS: Record<string, DecisionsQuestion> = { advice: ADVICE_QUESTION };

interface AdviceRow {
  input: string;
  expected: string;
  got: string;
  noul: number | null;
  pass: boolean;
  ms: number;
  cost: number;
  error?: string;
}

async function runCase(apiKey: string, test: TestCase<AdviceOutcome>): Promise<AdviceRow> {
  const base = {
    input: test.input.split("\n")[0].slice(0, 60),
    expected: fmt(test.expected),
    got: "(error)",
    noul: null,
    pass: false,
    ms: 0,
    cost: 0,
  };
  try {
    const result = await decisionsComplete(
      { model: MODEL, state: test.input, questions: QUESTIONS },
      { apiKey, timeoutMs: 60_000 },
    );
    const answer: DecisionsAnswer | undefined = result.answers.advice;
    const noul = answer?.type === "noul" ? answer.noul : null;
    const got = noul === null ? "(none)" : adviceBlocks(noul) ? "block" : "allow";
    return { ...base, got, noul, pass: got === test.expected, ms: result.ms, cost: result.usage.cost };
  } catch (err) {
    return { ...base, error: String(err).slice(0, 160) };
  }
}

const apiKey = resolveProviderKey(PROVIDER);
const fixture = makeFixture(process.env.BENCH_SEED);
const tests = selectTests(buildAdvisoryTests(fixture));
const rows = await mapWithConcurrency(tests, CONCURRENCY, (test) => runCase(apiKey, test));

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

console.log(
  `${BOLD}${MODEL} via ${PROVIDER}${RESET}  ${DIM}${tests.length} tests, 1 noul per test, concurrency ${CONCURRENCY}${RESET}\n`,
);
for (const row of rows) {
  const icon = row.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  const noul = row.noul === null ? "  -  " : row.noul.toFixed(2);
  console.log(`  ${icon}  ${row.got.padEnd(6)} want ${row.expected.padEnd(6)} noul ${noul}  ${row.input}`);
  if (row.error) console.log(`      ${DIM}${row.error}${RESET}`);
}
const passed = rows.filter((r) => r.pass).length;
const byExpected = Object.entries(
  rows.reduce<Record<string, { total: number; passed: number }>>((acc, row) => {
    acc[row.expected] ??= { total: 0, passed: 0 };
    acc[row.expected].total++;
    if (row.pass) acc[row.expected].passed++;
    return acc;
  }, {}),
)
  .map(([expected, { total, passed: p }]) => `${p}/${total} ${expected}`)
  .join("  ");
console.log(`\n  ${BOLD}${passed}/${rows.length}${RESET}  ${DIM}[${byExpected}]${RESET}\n`);

// Offline threshold sweeps without re-running the model.
const dump = process.env.BENCH_DUMP;
if (dump) {
  writeFileSync(
    dump,
    `${rows.map((row, i) => JSON.stringify({ ...row, fullInput: tests[i]?.input ?? row.input })).join("\n")}\n`,
  );
}
