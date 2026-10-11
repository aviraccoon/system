/**
 * Offline sweep of jev benchmark dumps.
 *
 * `BENCH_DUMP=<path> bun run benchmarks/jev.ts` in config/llm/pi writes one JSON
 * row per fixture: the state, the expected verdict, the derived verdict, the
 * severity score and every factor probability. This script re-scores those rows
 * under different policy numbers without a model call, and diffs two dumps to
 * show which cases flipped between runs.
 *
 * Usage:
 *   bun scripts/llm/bench-sweep.ts <dump.jsonl> [<dump2.jsonl>]
 */

import { readFileSync } from "node:fs";
import { applyEditFloor } from "../../config/llm/pi/extensions/permission-gate/explain";
import { SEVERITY_DANGEROUS, verdictFromFactors } from "../../config/llm/pi/extensions/shared/risk-factors";

interface Row {
  input: string;
  fullInput?: string;
  expected: string;
  derived: string;
  severity?: number | null;
  modelChoice?: string;
  probabilities?: Record<string, number>;
  error?: string;
}

function load(path: string): Row[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);
}

/** Matches the benchmark's own fixture-state predicate (see benchmarks/explain-cases.ts). */
const isEditLike = (state: string): boolean => /^(write to|edit |patch )/.test(state);
const wants = (row: Row, verdict: string): boolean => row.expected.split("|").includes(verdict);

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error("usage: bench-sweep.ts <dump.jsonl> [<dump2.jsonl>]");

const runs = paths.map(load);

for (const [index, rows] of runs.entries()) {
  // A scoreless or factor-less row is one the gate refuses to act on; it cannot
  // be re-scored, so it is excluded rather than counted as a pass.
  const usable = rows.filter((row) => row.probabilities && row.severity !== null && row.severity !== undefined);
  const skipped = rows.length - usable.length;
  const passed = usable.filter((row) => wants(row, row.derived)).length;
  console.log(
    `\n── ${paths[index]}: ${usable.length} cases, derived ${passed}/${usable.length}${skipped > 0 ? ` (${skipped} incomplete, skipped)` : ""}`,
  );

  const byExpected = new Map<string, number[]>();
  for (const row of usable) {
    if (row.severity === null || row.severity === undefined) continue;
    const list = byExpected.get(row.expected) ?? [];
    list.push(row.severity);
    byExpected.set(row.expected, list);
  }
  for (const [expected, values] of [...byExpected].sort()) {
    values.sort((a, b) => a - b);
    console.log(
      `   severity ${expected.padEnd(16)} n=${values.length} min=${values[0]?.toFixed(1)} med=${values[Math.floor(values.length / 2)]?.toFixed(1)} max=${values.at(-1)?.toFixed(1)}`,
    );
  }

  console.log("   severity rules (promote to dangerous when score > T), passes:");
  for (const threshold of [SEVERITY_DANGEROUS - 0.5, SEVERITY_DANGEROUS, SEVERITY_DANGEROUS + 0.5]) {
    let passes = 0;
    for (const row of usable) {
      const promoted =
        row.severity !== null && row.severity !== undefined && row.severity > threshold && row.derived !== "dangerous"
          ? "dangerous"
          : row.derived;
      if (wants(row, promoted)) passes++;
    }
    console.log(`     T=${threshold}: ${((passes / usable.length) * 100).toFixed(1)}%`);
  }

  console.log("   threshold grid (risky \\ dangerous), passes:");
  for (const risky of [0.4, 0.5, 0.6]) {
    const cells: string[] = [];
    for (const dangerous of [0.6, 0.7, 0.8]) {
      let passes = 0;
      for (const row of usable) {
        // The severity promotion belongs to the policy the grid claims to sweep.
        const decision = verdictFromFactors(row.probabilities ?? {}, { dangerous, risky }, row.severity ?? null);
        const verdict = applyEditFloor(
          { verdict: decision.verdict, short: "", detail: "" },
          isEditLike(row.fullInput ?? row.input),
        ).verdict;
        if (wants(row, verdict)) passes++;
      }
      cells.push(`${((passes / usable.length) * 100).toFixed(1)}%`.padStart(6));
    }
    console.log(`     ${risky.toFixed(1)}          ${cells.join(" ")}`);
  }

  const misses = usable.filter((row) => !wants(row, row.derived));
  if (misses.length > 0) {
    console.log(`   misses (${misses.length}):`);
    for (const row of misses)
      console.log(`     ${row.derived.padEnd(9)} want ${row.expected.padEnd(15)} ${row.input.slice(0, 70)}`);
  }
}

if (runs.length === 2) {
  const [first, second] = runs as [Row[], Row[]];
  const byInput = new Map(first.map((row) => [row.fullInput ?? row.input, row]));
  let derivedFlips = 0;
  let modelFlips = 0;
  console.log("\n── flips between the two dumps");
  for (const row of second) {
    const before = byInput.get(row.fullInput ?? row.input);
    if (!before) continue;
    if (before.derived !== row.derived) {
      derivedFlips++;
      console.log(`   derived ${before.derived} -> ${row.derived}  want ${row.expected}  ${row.input.slice(0, 70)}`);
    }
    if (before.modelChoice !== row.modelChoice) modelFlips++;
  }
  console.log(`   derived flips: ${derivedFlips}/${second.length}, model-choice flips: ${modelFlips}/${second.length}`);
}
