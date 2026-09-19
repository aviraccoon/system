/**
 * Shared benchmark infrastructure — role/model resolution, runner, output.
 *
 * Reads model config from ~/.pi/agent/roles.json + models.json (custom providers),
 * and @earendil-works/pi-ai (built-in providers/models). This matches pi's own
 * ModelRegistry merging: built-in models are available without models.json entries,
 * and custom providers override or extend them.
 *
 * Usage in role-specific benchmarks:
 *
 *   import { runBenchmark, type BenchConfig } from "./shared.js";
 *   const config: BenchConfig<MyTest> = { role: "draft", ... };
 *   runBenchmark(config);
 *
 * CLI:
 *   bun run benchmarks/draft.ts                        # all models for role
 *   bun run benchmarks/draft.ts --model omlx/Qwen3.6   # specific model(s)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { type BuiltinProvider, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Config types ──

interface ProviderConfig {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  models?: Array<{ id: string; name?: string; baseUrl?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface ModelsFile {
  providers: Record<string, ProviderConfig>;
}

interface RoleModelEntry {
  ref: string;
  thinking?: string;
  maxAttempts?: number;
  requestParams?: Record<string, unknown>;
}

interface RoleConfig {
  maxTokens?: number;
  models: RoleModelEntry[];
}

type RolesFile = Record<string, RoleConfig>;

// ── File loading ──

function loadJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Load custom provider configs from models.json. */
export function loadProviders(path?: string): Record<string, ProviderConfig> {
  const models = loadJsonFile<ModelsFile>(path ?? join(getAgentDir(), "models.json"));
  return models?.providers ?? {};
}

function loadRoles(path?: string): RolesFile {
  const roles = loadJsonFile<RolesFile>(path ?? join(getAgentDir(), "roles.json"));
  return roles ?? {};
}

// ── Resolution ──

/** Resolve "!command" apiKeys by running the command. */
function resolveApiKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("!")) {
    try {
      return execSync(raw.slice(1), { encoding: "utf-8" }).trim();
    } catch {
      return raw;
    }
  }
  return raw;
}

export interface ResolvedModel {
  label: string;
  ref: string;
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  maxTokens: number;
  extra: Record<string, unknown>;
}

/**
 * Resolve models for a role from roles.json, using pi's model merging:
 * 1. Built-in models from @earendil-works/pi-ai (baseUrl, model definitions)
 * 2. Custom provider configs from models.json (baseUrl, apiKey overrides, custom models)
 *
 * Optionally filter to specific refs via --model CLI args.
 */
export function resolveRoleModels(
  roleName: string,
  modelFilters?: string[],
  options?: { rolesPath?: string; providersPath?: string },
): ResolvedModel[] {
  const roles = loadRoles(options?.rolesPath);
  const customProviders = loadProviders(options?.providersPath);

  const role = roles[roleName];
  if (!role) {
    const available = Object.keys(roles).join(", ");
    throw new Error(`Role "${roleName}" not found in roles.json. Available: ${available}`);
  }

  const entries = modelFilters?.length
    ? role.models.filter((m) => modelFilters.some((f) => m.ref.includes(f)))
    : role.models.slice(0, 1);

  // Allow --model refs that aren't in the role config — useful for ad-hoc testing.
  // e.g. --model omlx/gpt-oss-20b-MXFP4-Q8 even if it's not in roles.json.
  if (modelFilters?.length) {
    for (const filter of modelFilters) {
      const hasSlash = filter.includes("/");
      const alreadyListed = entries.some((e) => e.ref === filter);
      if (hasSlash && !alreadyListed) {
        entries.push({ ref: filter });
      }
    }
  }

  if (entries.length === 0) {
    if (modelFilters?.length) {
      const available = role.models.map((m) => m.ref).join(", ");
      throw new Error(
        `No models in role "${roleName}" match filters: ${modelFilters.join(", ")}. Available: ${available}`,
      );
    }
    throw new Error(`Role "${roleName}" has no models configured.`);
  }

  // Build a lookup of built-in models by "provider/id"
  const builtInProviders = new Set(getBuiltinProviders());
  const builtInLookup = new Map<string, { baseUrl: string; name?: string }>();
  for (const provider of builtInProviders) {
    for (const m of getBuiltinModels(provider)) {
      builtInLookup.set(`${provider}/${m.id}`, { baseUrl: m.baseUrl, name: m.name });
    }
  }

  return entries.map((entry) => {
    const slash = entry.ref.indexOf("/");
    if (slash === -1) throw new Error(`Invalid ref "${entry.ref}" — expected "provider/modelId"`);
    const providerName = entry.ref.slice(0, slash);
    const modelId = entry.ref.slice(slash + 1);

    // Try custom provider config first
    const customProvider = customProviders[providerName];

    // Resolve baseUrl: custom provider > custom model > built-in
    let baseUrl: string | undefined;
    let modelName: string | undefined;

    if (customProvider) {
      // Check if custom provider defines this specific model
      const customModel = customProvider.models?.find((m) => m.id === modelId);
      baseUrl = customModel?.baseUrl ?? customProvider.baseUrl;
      modelName = customModel?.name;
    }

    // Fall back to built-in model
    if (!baseUrl) {
      const builtIn = builtInLookup.get(entry.ref);
      if (builtIn) {
        baseUrl = builtIn.baseUrl;
        modelName ??= builtIn.name;
      }
    }

    if (!baseUrl) {
      throw new Error(
        `Model "${entry.ref}" not found in models.json or built-in providers. ` +
          `Provider "${providerName}" is ${builtInProviders.has(providerName as BuiltinProvider) ? "built-in" : "custom"}.`,
      );
    }

    // Resolve apiKey: models.json > env var
    let apiKey = resolveApiKey(customProvider?.apiKey);
    if (!apiKey) {
      apiKey = getEnvApiKey(providerName);
    }

    return {
      label: modelName ?? entry.ref,
      ref: entry.ref,
      baseUrl,
      model: modelId,
      apiKey,
      maxTokens: role.maxTokens ?? 256,
      extra: entry.requestParams ?? {},
    };
  });
}

/** Parse --model args from process.argv. */
export function parseModelArgs(): string[] | undefined {
  const args = process.argv.slice(2);
  const models: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      models.push(args[++i]);
    } else if (args[i]?.startsWith("--model=")) {
      models.push(args[i].slice("--model=".length));
    }
  }
  return models.length > 0 ? models : undefined;
}

// ── Test infrastructure ──

export interface TestCase<T = string> {
  input: string;
  /** Expected result — single value or array for borderline cases */
  expected: T | T[];
}

export interface TestResult {
  input: string;
  expected: string;
  got: string;
  pass: boolean;
  ms: number;
  response: string;
}

/**
 * Parse raw model output into a structured result.
 * Returns null if the output doesn't match expected format.
 */
export type OutputParser<T extends string> = (text: string) => T | null;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Build the message array for a test case. Receives the test input. */
export type MessageBuilder = (input: string) => ChatMessage[];

/**
 * Run a single test case against a model.
 */
export async function runOne<T extends string>(
  model: ResolvedModel,
  test: TestCase<T>,
  systemPrompt: string,
  parseOutput: OutputParser<T>,
  buildMessages?: MessageBuilder,
): Promise<TestResult> {
  const messages: ChatMessage[] = buildMessages
    ? buildMessages(test.input)
    : [
        { role: "system", content: systemPrompt },
        { role: "user", content: test.input },
      ];
  const body: Record<string, unknown> = {
    model: model.model,
    max_tokens: model.maxTokens,
    messages,
    ...model.extra,
  };

  const start = performance.now();
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const ms = Math.round(performance.now() - start);

  if (!res.ok) {
    const err = await res.text();
    return {
      input: test.input.split("\n")[0].slice(0, 40),
      expected: fmt(test.expected),
      got: `HTTP ${res.status}`,
      pass: false,
      ms,
      response: err.slice(0, 100),
    };
  }

  const data = await res.json();
  const content: string = data.choices?.[0]?.message?.content ?? "";
  const got = parseOutput(content);
  return {
    input: test.input.split("\n")[0].slice(0, 40),
    expected: fmt(test.expected),
    got: got ?? "(none)",
    pass: got !== null && (Array.isArray(test.expected) ? test.expected.includes(got) : got === test.expected),
    ms,
    response: content.split("\n")[0].slice(0, 80),
  };
}

/** Format expected value(s) for display. */
export function fmt(expected: string | string[]): string {
  return Array.isArray(expected) ? expected.join("|") : expected;
}

// ── Output formatting ──

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Color for a given verdict string. Override per-role if needed. */
export function valueColor(v: string): string {
  if (v === "safe" || v === "pass" || v === "yes") return GREEN;
  if (v === "risky" || v === "warn" || v === "partial") return YELLOW;
  if (v === "dangerous" || v === "fail" || v === "no") return RED;
  return DIM;
}

export interface BenchConfig<T extends string> {
  /** Role name — resolved from roles.json + models.json + built-in models */
  role: string;
  systemPrompt: string;
  tests: TestCase<T>[];
  parseOutput: OutputParser<T>;
  /** Color function for output values (defaults to valueColor) */
  color?: (v: string) => string;
  /** Custom message builder. Overrides default [system, user] construction. */
  buildMessages?: MessageBuilder;
}

/** Run tasks with bounded concurrency, preserving input order. */
export async function mapWithConcurrency<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Concurrency for case execution. Cases are independent requests, so the run
 *  is limited by the provider, not the runner. Override with BENCH_CONCURRENCY. */
function parseConcurrency(): number {
  const raw = Number(process.env.BENCH_CONCURRENCY ?? 6);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 6;
}

export async function runBenchmark<T extends string>(config: BenchConfig<T>): Promise<void> {
  const modelFilters = parseModelArgs();
  const resolved = resolveRoleModels(config.role, modelFilters);
  const color = config.color ?? valueColor;
  const concurrency = parseConcurrency();

  // Print model plan up front
  console.log(
    `\n${BOLD}Role:${RESET} ${config.role}  ${BOLD}Models:${RESET} ${resolved.map((m) => m.label).join(", ")}  ${DIM}(${resolved.length} model${resolved.length > 1 ? "s" : ""}, ${config.tests.length} tests, concurrency ${concurrency})${RESET}`,
  );

  for (const model of resolved) {
    console.log(`\n${BOLD}${model.label}${RESET}\n`);

    const rows = await mapWithConcurrency(config.tests, concurrency, (test) =>
      runOne(model, test, config.systemPrompt, config.parseOutput, config.buildMessages),
    );

    for (const r of rows) {
      const icon = r.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      const gotCol = color(r.got);
      const expCol = color(r.expected);
      const gotPad = r.got.padEnd(9);
      const expPad = r.expected.padEnd(14);
      const ms = `${DIM}${String(r.ms).padStart(3)}ms${RESET}`;
      const { input } = r;

      console.log(`  ${icon}  ${gotCol}${gotPad}${RESET} want ${expCol}${expPad}${RESET} ${ms}  ${input}`);

      if (!r.pass) {
        console.log(`      ${DIM}${r.response}${RESET}`);
      }
    }

    printSummary(rows);
  }
}

export function printSummary(rows: TestResult[]): void {
  const passed = rows.filter((r) => r.pass).length;
  const total = rows.length;
  const pct = ((passed / total) * 100).toFixed(0);
  const avgMs = Math.round(rows.reduce((s, r) => s + r.ms, 0) / total);

  const byCategory: Record<string, { total: number; passed: number }> = {};
  for (const r of rows) {
    byCategory[r.expected] ??= { total: 0, passed: 0 };
    byCategory[r.expected].total++;
    if (r.pass) byCategory[r.expected].passed++;
  }
  const breakdown = Object.entries(byCategory)
    .map(([cat, { total: t, passed: p }]) => `${p}/${t} ${cat}`)
    .join("  ");

  console.log(`\n  ${BOLD}${passed}/${total} (${pct}%)${RESET}  avg ${avgMs}ms  ${DIM}[${breakdown}]${RESET}\n`);
}
