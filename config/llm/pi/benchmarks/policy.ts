/**
 * Policy benchmark.
 *
 * Run: BENCH_SEED=run-a bun run benchmarks/policy.ts
 *
 * Three measurements, in one run because all of them cost cents:
 *
 * 1. **Policy accuracy per policy length.** The same synthetic cases against a
 *    short policy (nine clauses) and a long one (the same nine with reasons,
 *    plus six a real project accumulates). The clause citation is scored
 *    separately: a refusal that fires for the right reason and one that fires
 *    citing nothing are not the same result.
 * 2. **A clause on another axis.** One policy carries a timeout budget and no
 *    binding, so the only thing that can refuse a call is the budget. A guard
 *    whose question is written around where work runs cannot pass these.
 * 3. **Contamination.** The risk-factor battery is asked twice over identical
 *    states: alone, and beside the policy questions. A factor probability that
 *    moves is what a merge of the two into one request would cost.
 *
 * `BENCH_GROUP` selects case groups, `BENCH_SEED` fixes the risk fixtures,
 * `POLICY_THRESHOLD` moves the refusal threshold, `CONTAM_CASES` sets how many
 * risk states the contamination run uses, `BENCH_DUMP` writes JSONL rows.
 */

import { writeFileSync } from "node:fs";
import {
  DEFAULT_DECISIONS_MODEL,
  type DecisionsAnswer,
  type DecisionsQuestion,
  decisionsComplete,
} from "../extensions/shared/decisions";
import { clauseQuestions, DEFAULT_POLICY_THRESHOLD, judgePolicy, type Policy } from "../extensions/shared/policy";
import { decisionFromAnswers, factorProbabilities, RISK_FACTORS } from "../extensions/shared/risk-factors";
import { buildTests, makeFixture } from "./explain-cases";
import {
  LONG_POLICY,
  POLICY_CASES,
  type PolicyCase,
  SHORT_POLICY,
  TIMEOUT_CASES,
  TIMEOUT_POLICY,
} from "./policy-cases";
import { citationRows, mapWithConcurrency, policyClausePass, policyRowPass, resolveProviderKey } from "./shared";

const MODEL = process.env.JEV_MODEL ?? DEFAULT_DECISIONS_MODEL;
const PROVIDER = process.env.JEV_PROVIDER ?? "openrouter-sidecar";
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);
const THRESHOLD = Number(process.env.POLICY_THRESHOLD ?? DEFAULT_POLICY_THRESHOLD);
const CONTAM_CASES = Number(process.env.CONTAM_CASES ?? 18);
const DUMP = process.env.BENCH_DUMP;

/** Every case either policy set carries, so a group filter can name any of them. */
const ALL_CASES: PolicyCase[] = [...POLICY_CASES, ...TIMEOUT_CASES];

const POLICIES: { name: string; policy: Policy }[] = [
  { name: "short", policy: SHORT_POLICY },
  { name: "long", policy: LONG_POLICY },
  { name: "timeout", policy: TIMEOUT_POLICY },
];

function selectedCases(): PolicyCase[] {
  const wanted = (process.env.BENCH_GROUP ?? "all").split(/[,\s]+/).filter(Boolean);
  if (wanted.length === 0 || wanted.includes("all")) return ALL_CASES;
  const groups = new Set(ALL_CASES.map((c) => c.group));
  for (const name of wanted) {
    if (!groups.has(name as PolicyCase["group"])) {
      throw new Error(`unknown group "${name}"; available: ${[...groups].join(", ")}`);
    }
  }
  return ALL_CASES.filter((c) => wanted.includes(c.group));
}

interface PolicyRow {
  id: string;
  group: string;
  expected: boolean;
  got: boolean | null;
  probability: number | null;
  expectedClause: string | null;
  citedClause: string | null;
  /** Clause ids the judge did not answer; they were not checked. */
  missing: string[];
  pass: boolean;
  clausePass: boolean | null;
  ms: number;
  cost: number;
  error?: string;
}

function questionSet(policy: Policy): Record<string, DecisionsQuestion> {
  return clauseQuestions(policy);
}

async function runPolicyCase(apiKey: string, policy: Policy, test: PolicyCase): Promise<PolicyRow> {
  const base = {
    id: test.id,
    group: test.group,
    expected: test.expected,
    expectedClause: test.clause ?? null,
    got: null,
    probability: null,
    citedClause: null,
    missing: [],
    pass: false,
    clausePass: null,
    ms: 0,
    cost: 0,
  };
  const options = { apiKey, timeoutMs: 60_000 };
  let ms = 0;
  let cost = 0;
  try {
    // The guard's own call: every clause in one request, the threshold in code.
    const ask = async (questions: Record<string, DecisionsQuestion>, asked: Record<string, unknown>) => {
      const result = await decisionsComplete({ model: MODEL, state: asked, questions }, options);
      ms += result.ms;
      cost += result.usage.cost;
      return result.answers;
    };
    const verdict = await judgePolicy(ask, policy, test.facts, THRESHOLD);
    // One rule for the citation, shared with the pass rule, so the table's marker and its ok column agree.
    const clausePass = policyClausePass(verdict, test.expected, test.clause ?? null);
    return {
      ...base,
      got: verdict.violation,
      probability: verdict.probability,
      citedClause: verdict.clause,
      missing: verdict.missing,
      pass: policyRowPass(verdict, test.expected, test.clause ?? null),
      clausePass,
      ms,
      cost,
    };
  } catch (err) {
    // One request, so a failure is the only way a row errors.
    return { ...base, ms, cost, error: `decide: ${String(err).slice(0, 160)}` };
  }
}

function printPolicyTable(policyName: string, rows: PolicyRow[]): void {
  const head = ["case", "group", "want", "got", "p", "cite", "ok"];
  const widths = [26, 10, 5, 5, 5, 12, 4];
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 10)).join(" ");
  console.log(`\n## ${policyName} policy`);
  console.log(line(head));
  for (const row of rows) {
    const got = row.got === null ? "(none)" : row.got ? "deny" : "allow";
    const cite = row.citedClause
      ? row.expectedClause
        ? `${row.citedClause}${row.clausePass === false ? "!" : "="}`
        : row.citedClause
      : "-";
    console.log(
      `${line([
        row.id.slice(0, 25),
        row.group,
        row.expected ? "deny" : "allow",
        got,
        row.probability === null ? "-" : row.probability.toFixed(2),
        cite,
        row.pass ? "ok" : "FAIL",
      ])}${row.error ? `  ${row.error}` : ""}${row.missing.length > 0 ? `  missing: ${row.missing.join(", ")}` : ""}`,
    );
  }
}

function summarizePolicy(rows: PolicyRow[]): {
  pass: number;
  falsePositives: string[];
  falseNegatives: string[];
  clausePass: number;
  clauseTotal: number;
  /** Rows where the judge left a clause unanswered, so the verdict came from part of the policy. */
  missingRows: number;
  cost: number;
  meanMs: number;
} {
  const falsePositives = rows.filter((r) => r.got === true && !r.expected).map((r) => r.id);
  const falseNegatives = rows.filter((r) => r.got !== true && r.expected).map((r) => r.id);
  // A row with an unchecked clause is not counted here: its citation came from part of the policy.
  const clauseRows = citationRows(rows);
  return {
    pass: rows.filter((r) => r.pass).length,
    falsePositives,
    falseNegatives,
    clausePass: clauseRows.filter((r) => r.clausePass === true).length,
    clauseTotal: clauseRows.length,
    missingRows: rows.filter((r) => r.missing.length > 0).length,
    cost: rows.reduce((sum, r) => sum + r.cost, 0),
    meanMs: rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + r.ms, 0) / rows.length,
  };
}

// ── Contamination ────────────────────────────────────────────────────────────

interface ContamRow {
  state: string;
  baseline: Record<string, number>;
  short: Record<string, number>;
  long: Record<string, number>;
  baselineVerdict: string;
  shortVerdict: string;
  longVerdict: string;
  cost: number;
  ms: number;
}

function verdictOf(answers: Record<string, DecisionsAnswer>, containerFacts: boolean): string {
  const decision = decisionFromAnswers(answers, { containerFacts });
  return decision?.verdict ?? "(incomplete)";
}

async function ask(
  apiKey: string,
  state: string,
  questions: Record<string, DecisionsQuestion>,
): Promise<{ answers: Record<string, DecisionsAnswer>; cost: number; ms: number }> {
  const result = await decisionsComplete({ model: MODEL, state, questions }, { apiKey, timeoutMs: 60_000 });
  return { answers: result.answers, cost: result.usage.cost, ms: result.ms };
}

async function runContamination(
  apiKey: string,
  states: { input: string; containerFacts?: boolean }[],
): Promise<ContamRow[]> {
  return mapWithConcurrency(states, CONCURRENCY, async (test) => {
    const base = await ask(apiKey, test.input, RISK_FACTORS);
    const withShort = await ask(apiKey, test.input, { ...RISK_FACTORS, ...questionSet(SHORT_POLICY) });
    const withLong = await ask(apiKey, test.input, { ...RISK_FACTORS, ...questionSet(LONG_POLICY) });
    const containerFacts = test.containerFacts === true;
    return {
      state: test.input.split("\n")[0].slice(0, 60),
      baseline: factorProbabilities(base.answers),
      short: factorProbabilities(withShort.answers),
      long: factorProbabilities(withLong.answers),
      baselineVerdict: verdictOf(base.answers, containerFacts),
      shortVerdict: verdictOf(withShort.answers, containerFacts),
      longVerdict: verdictOf(withLong.answers, containerFacts),
      cost: base.cost + withShort.cost + withLong.cost,
      ms: base.ms + withShort.ms + withLong.ms,
    };
  });
}

function printContamination(rows: ContamRow[]): void {
  const factors = Object.keys(RISK_FACTORS);
  const delta = (a: Record<string, number>, b: Record<string, number>, factor: string) =>
    Math.abs((a[factor] ?? 0) - (b[factor] ?? 0));
  console.log("\n## contamination (factor probability shift, same states)");
  console.log(["factor".padEnd(26), "max short".padEnd(10), "max long".padEnd(10), "mean long"].join(" "));
  for (const factor of factors) {
    const short = rows.map((r) => delta(r.baseline, r.short, factor));
    const long = rows.map((r) => delta(r.baseline, r.long, factor));
    const max = (values: number[]) => (values.length === 0 ? 0 : Math.max(...values));
    const mean = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);
    console.log(
      [
        factor.padEnd(26),
        max(short).toFixed(2).padEnd(10),
        max(long).toFixed(2).padEnd(10),
        mean(long).toFixed(3),
      ].join(" "),
    );
  }
  const moved = rows.filter((r) => r.baselineVerdict !== r.shortVerdict || r.baselineVerdict !== r.longVerdict);
  console.log(`\nverdict changes: ${moved.length}/${rows.length}`);
  for (const row of moved) {
    console.log(`  ${row.state}: ${row.baselineVerdict} -> short ${row.shortVerdict} / long ${row.longVerdict}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────

const apiKey = resolveProviderKey(PROVIDER);
const cases = selectedCases();
const fixture = makeFixture(process.env.BENCH_SEED);
const riskStates = buildTests(fixture)
  .filter((test) => test.input.startsWith("bash command:"))
  .slice(0, CONTAM_CASES);

let totalCost = 0;
const dump: unknown[] = [];

for (const { name, policy } of POLICIES) {
  const pool = name === "timeout" ? TIMEOUT_CASES : POLICY_CASES;
  const policyCases = pool.filter((c) => cases.includes(c));
  const rows = await mapWithConcurrency(policyCases, CONCURRENCY, (test) => runPolicyCase(apiKey, policy, test));
  printPolicyTable(name, rows);
  const summary = summarizePolicy(rows);
  totalCost += summary.cost;
  console.log(
    `${summary.pass}/${rows.length} pass, ${summary.falsePositives.length} false positive` +
      ` (${summary.falsePositives.join(", ") || "none"}), ${summary.falseNegatives.length} false negative` +
      ` (${summary.falseNegatives.join(", ") || "none"}), citation ${summary.clausePass}/${summary.clauseTotal},` +
      ` ${summary.missingRows} with an unchecked clause,` +
      ` mean ${Math.round(summary.meanMs)} ms, $${summary.cost.toFixed(4)}`,
  );
  dump.push({ kind: "policy", policy: name, rows });
}

if (riskStates.length > 0) {
  const rows = await runContamination(apiKey, riskStates);
  printContamination(rows);
  const cost = rows.reduce((sum, row) => sum + row.cost, 0);
  totalCost += cost;
  console.log(`${riskStates.length} states, 3 asks each, $${cost.toFixed(4)}`);
  dump.push({ kind: "contamination", rows });
}

console.log(`\nmodel ${MODEL} via ${PROVIDER}, threshold ${THRESHOLD}, total $${totalCost.toFixed(4)}`);
if (DUMP) writeFileSync(DUMP, `${dump.map((row) => JSON.stringify(row)).join("\n")}\n`);
