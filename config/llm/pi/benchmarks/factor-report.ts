/**
 * Shared reporting for factor-based runs, so a decisions-model runner (jev.ts)
 * and a chat-model runner (factors.ts) print comparable tables.
 */

import { DEFAULT_THRESHOLDS, type FactorVerdict } from "../extensions/shared/risk-factors";
import { valueColor } from "./shared";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export interface FactorRow {
  input: string;
  expected: string;
  derived: FactorVerdict | string;
  derivedReasons: string[];
  derivedPass: boolean;
  modelChoice: string;
  modelPass: boolean;
  agrees: boolean;
  ms: number;
  cost: number;
  error?: string;
}

export interface FactorRun {
  /** What produced the answers, e.g. "<decisions model> via <provider>". */
  label: string;
  /** Short parenthetical, e.g. "58 tests, 10 factors + 1 choice, concurrency 6". */
  meta: string;
  rows: FactorRow[];
}

export function printFactorRun(run: FactorRun): void {
  const { rows } = run;
  console.log(`\n${BOLD}Run:${RESET} ${run.label}  ${DIM}(${run.meta})${RESET}`);
  console.log(
    `  ${DIM}icons: <derived><model-choice> vs want; thresholds dangerous>=${DEFAULT_THRESHOLDS.dangerous} risky>=${DEFAULT_THRESHOLDS.risky}${RESET}\n`,
  );

  let cost = 0;
  for (const row of rows) {
    cost += row.cost;
    const dIcon = row.derivedPass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const mIcon = row.modelPass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
    const reasons = row.derivedReasons.length > 0 ? `[${row.derivedReasons.join(",")}]` : "[]";
    console.log(
      `  ${dIcon}${mIcon} ${valueColor(row.derived)}${row.derived.padEnd(9)}${RESET} model ${valueColor(row.modelChoice)}${row.modelChoice.padEnd(9)}${RESET} want ${row.expected.padEnd(15)} ${DIM}${row.ms}ms${RESET} ${reasons.padEnd(24)} ${row.input}`,
    );
    if (row.error) console.log(`      ${DIM}${row.error}${RESET}`);
  }

  const derivedPassed = rows.filter((r) => r.derivedPass).length;
  const modelPassed = rows.filter((r) => r.modelPass).length;
  const agreements = rows.filter((r) => r.agrees).length;
  const byCategory = new Map<string, { derived: number; model: number; total: number }>();
  for (const row of rows) {
    const entry = byCategory.get(row.expected) ?? { derived: 0, model: 0, total: 0 };
    entry.total++;
    if (row.derivedPass) entry.derived++;
    if (row.modelPass) entry.model++;
    byCategory.set(row.expected, entry);
  }
  const breakdown = [...byCategory.entries()]
    .map(([category, { derived, model, total }]) => `${category} ${derived}/${model}/${total}`)
    .join("  ");
  const avgMs = Math.round(rows.reduce((sum, r) => sum + r.ms, 0) / Math.max(1, rows.length));

  console.log(
    `\n  ${BOLD}derived ${derivedPassed}/${rows.length}${RESET}  model-choice ${modelPassed}/${rows.length}  agreement ${agreements}/${rows.length}  avg ${avgMs}ms  total $${cost.toFixed(5)}`,
  );
  console.log(`  ${DIM}per category derived/model/want: ${breakdown}${RESET}\n`);
}
