/**
 * Message-question benchmark: does the classifier agree that a report did or
 * did not judge the proposed commit message?
 *
 * Cases are synthetic (`message-cases.ts`); no session or repository text is
 * read. One noul per case, the same question the gate asks; the answer at its
 * threshold is the decision.
 *
 * Run:
 *   bun run benchmarks/message.ts
 *   MESSAGE_THRESHOLD=0.8 bun run benchmarks/message.ts
 *   BENCH_DUMP=/tmp/message.jsonl bun run benchmarks/message.ts
 *
 * The model comes from MESSAGE_MODEL or the decisions pin; MESSAGE_PROVIDER
 * selects the provider and BENCH_GROUP selects case groups.
 */

import { writeFileSync } from "node:fs";
import { DEFAULT_DECISIONS_MODEL, decisionsComplete } from "../extensions/shared/decisions";
import {
  DEFAULT_MESSAGE_THRESHOLD,
  MESSAGE_JUDGED_QUESTION,
  messageJudgmentFromAnswers,
} from "../extensions/shared/review-message";
import { MESSAGE_CASES, type MessageCase } from "./message-cases";
import { mapWithConcurrency, resolveProviderKey, selectTests } from "./shared";
import { passes, scoreAt, sweep, type VerdictRow } from "./verdict-cases";

const MODEL = process.env.MESSAGE_MODEL ?? DEFAULT_DECISIONS_MODEL;
const PROVIDER = process.env.MESSAGE_PROVIDER ?? "openrouter";
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);
const THRESHOLD = Number(process.env.MESSAGE_THRESHOLD ?? DEFAULT_MESSAGE_THRESHOLD);

async function runCase(apiKey: string, test: MessageCase): Promise<VerdictRow> {
  const base = { id: test.id, group: test.group, expected: test.expected, pBlocking: null, ms: 0, cost: 0 };
  try {
    const result = await decisionsComplete(
      {
        model: MODEL,
        state: { reviewTarget: "the staged change", proposedMessage: test.proposedMessage, report: test.input },
        questions: { message: MESSAGE_JUDGED_QUESTION },
      },
      { apiKey, timeoutMs: 60_000 },
    );
    const judgment = messageJudgmentFromAnswers(result.answers, THRESHOLD);
    return {
      ...base,
      pBlocking: judgment?.probability ?? null,
      blocking: judgment?.failed,
      scores: { message: judgment?.probability ?? null },
      ms: result.ms,
      cost: result.usage.cost,
      ...(judgment ? {} : { error: "the question did not answer" }),
    };
  } catch (err) {
    return { ...base, error: String(err).slice(0, 160) };
  }
}

const apiKey = resolveProviderKey(PROVIDER);
const cases = selectTests(MESSAGE_CASES);
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
  console.log(`  ${icon}  ${row.group.padEnd(10)} want=${String(row.expected).padEnd(5)} p=${p}  ${row.id}`);
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

const dump = process.env.BENCH_DUMP;
if (dump) {
  writeFileSync(dump, `${rows.map((row, index) => JSON.stringify({ ...row, case: cases[index] })).join("\n")}\n`);
}
