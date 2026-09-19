/**
 * Risk-factor benchmark for chat models.
 *
 * Run: BENCH_SEED=run-a bun run benchmarks/factors.ts --model <provider/model>
 *
 * Asks a chat model the same factor battery Jev gets — risk-factors.ts renders
 * the questions and applies the same threshold policy to both — so the two
 * runners differ only in backend. Without --model it uses the first model of the
 * explain role.
 */

import { buildTests, makeFixture, type Verdict } from "./explain-cases";
import { type FactorRow, printFactorRun } from "./factor-report";
import { buildFactorsPrompt, DEFAULT_THRESHOLDS, parseFactorAnswers, verdictFromFactors } from "./risk-factors";
import {
  fmt,
  mapWithConcurrency,
  parseModelArgs,
  type ResolvedModel,
  resolveRoleModels,
  type TestCase,
} from "./shared";

const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 6);
const MAX_TOKENS = 2048;
const SYSTEM_PROMPT = buildFactorsPrompt();

function matches(expected: Verdict | Verdict[], got: string): boolean {
  return Array.isArray(expected) ? expected.includes(got as Verdict) : got === expected;
}

async function runCase(model: ResolvedModel, test: TestCase<Verdict>): Promise<FactorRow> {
  const base = { input: test.input.split("\n")[0].slice(0, 44), expected: fmt(test.expected), cost: 0 };
  const started = performance.now();
  try {
    const response = await fetch(`${model.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model.model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: test.input },
        ],
        ...model.extra,
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      const ms = Math.round(performance.now() - started);
      return {
        ...base,
        derived: "(error)",
        derivedReasons: [],
        derivedPass: false,
        modelChoice: "(error)",
        modelPass: false,
        agrees: false,
        ms,
        error: `HTTP ${response.status}: ${body.slice(0, 140)}`,
      };
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { cost?: number };
    };
    // Measured after the body is read: a chat model streams for a while past its
    // headers, and header-time would flatter it against a decisions call.
    const ms = Math.round(performance.now() - started);
    const content = data.choices?.[0]?.message?.content ?? "";
    const cost = typeof data.usage?.cost === "number" ? data.usage.cost : 0;
    const parsed = parseFactorAnswers(content);
    if (!parsed) {
      return {
        ...base,
        derived: "(unparsed)",
        derivedReasons: [],
        derivedPass: false,
        modelChoice: "(unparsed)",
        modelPass: false,
        agrees: false,
        ms,
        cost,
        error: content.split("\n")[0].slice(0, 140),
      };
    }
    const decision = verdictFromFactors(parsed.probabilities, DEFAULT_THRESHOLDS);
    const modelChoice = parsed.risk ?? "(none)";
    return {
      ...base,
      derived: decision.verdict,
      derivedReasons: decision.reasons,
      derivedPass: matches(test.expected, decision.verdict),
      modelChoice,
      modelPass: matches(test.expected, modelChoice),
      agrees: decision.verdict === modelChoice,
      ms,
      cost,
    };
  } catch (err) {
    return {
      ...base,
      derived: "(error)",
      derivedReasons: [],
      derivedPass: false,
      modelChoice: "(error)",
      modelPass: false,
      agrees: false,
      ms: Math.round(performance.now() - started),
      error: String(err).slice(0, 160),
    };
  }
}

const resolved = resolveRoleModels("explain", parseModelArgs());
const fixture = makeFixture(process.env.BENCH_SEED);
const tests = buildTests(fixture);

for (const model of resolved) {
  const rows = await mapWithConcurrency(tests, CONCURRENCY, (test) => runCase(model, test));
  printFactorRun({
    label: `${model.label} (${model.ref})`,
    meta: `${tests.length} tests, factor battery, concurrency ${CONCURRENCY}`,
    rows,
  });
}
