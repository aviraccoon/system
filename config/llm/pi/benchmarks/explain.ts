/**
 * Sidecar model benchmark — explain role (tool call safety classification).
 *
 * Run: bun run benchmarks/explain.ts [--model <ref>]
 *
 * Models come from the explain role in ~/.pi/agent/roles.json, with providers
 * resolved through models.json and pi-ai's built-in catalog.
 *
 * Cases live in explain-cases.ts. BENCH_SEED makes the fixtures reproducible so
 * another runner scores identical inputs.
 */

import { EXPLAIN_SYSTEM_PROMPT } from "../extensions/permission-gate/prompts";
import { buildTests, makeFixture, type Verdict } from "./explain-cases";
import { type BenchConfig, runBenchmark, valueColor } from "./shared";

// ── System prompt ──

// Same system prompt as permission-gate/prompts.ts
const SYSTEM_PROMPT = EXPLAIN_SYSTEM_PROMPT;

// ── Parse & run ──

function parseVerdict(text: string): Verdict | null {
  const m = text.trim().match(/^(SAFE|RISKY|DANGEROUS)\s*[|:\-–]/i);
  return m ? (m[1].toLowerCase() as Verdict) : null;
}

const config: BenchConfig<Verdict> = {
  role: "explain",
  systemPrompt: SYSTEM_PROMPT,
  tests: buildTests(makeFixture(process.env.BENCH_SEED)),
  parseOutput: parseVerdict,
  color: valueColor,
};

runBenchmark(config).catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
