/**
 * Model scan: discover interesting LLM models, detect config drift, find local MLX options.
 *
 * Usage:
 *   bun run scripts/model-scan.ts              # discover ZDR-eligible models, priced at ZDR endpoints
 *   bun run scripts/model-scan.ts --drift       # check current pi.nix config for drift
 *   bun run scripts/model-scan.ts --local       # find trending MLX models via oMLX
 *   bun run scripts/model-scan.ts --model <repo> # estimate specific HF repo (repeatable)
 *   bun run scripts/model-scan.ts -e a/b [-e c/d] # provider endpoints, cross-model compare on >=2
 *   bun run scripts/model-scan.ts --json        # machine-readable output
 *
 * Data sources:
 *   - OpenRouter /api/v1/models (public) + /api/v1/endpoints/zdr (global ZDR
 *     endpoint catalog: per-provider pricing and live status) + /api/v1/models/user
 *     (account-filtered ZDR model list)
 *   - Artificial Analysis /api/v2/data/llms/models (benchmarks, speed)
 *   - oMLX admin API (local MLX models, HF search)
 *   - ~/.pi/agent/models.json (current pi config)
 *
 * API reference:
 *   https://openrouter.ai/openapi.json documents the official API. Frontend-only
 *   stats endpoints (unofficial): /api/frontend/v1/stats/effective-pricing and
 *   /listed-pricing — keyed by permaslug (the dated canonical_slug from
 *   /api/v1/models, NOT the short id: short slugs return HTTP 200 with zeros,
 *   silently wrong).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ── ANSI helpers ──

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

// ── Types ──

interface ORModel {
  id: string;
  name: string;
  canonical_slug?: string;
  context_length: number | null;
  pricing: { prompt: string; completion: string; input_cache_read?: string; input_cache_write?: string };
  architecture: { input_modalities: string[]; output_modalities: string[] };
  top_provider: { context_length?: number | null; max_completion_tokens?: number | null; is_moderated: boolean };
  supported_parameters: string[];
  hugging_face_id: string | null;
  benchmarks?: {
    artificial_analysis?: { intelligence_index?: number; coding_index?: number; agentic_index?: number };
  };
}

interface AAModel {
  id: string;
  name: string;
  slug: string;
  release_date: string | null;
  model_creator: { id: string; name: string; slug: string };
  evaluations: Record<string, number | null>;
  pricing: { price_1m_blended_3_to_1: number; price_1m_input_tokens: number; price_1m_output_tokens: number };
  median_output_tokens_per_second: number | null;
  median_time_to_first_token_seconds: number | null;
}

interface PiProvider {
  baseUrl?: string;
  models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>;
}

interface PiModelsFile {
  providers: Record<string, PiProvider>;
}

/** One model's price signal for the default view, $/M. */
interface ModelPricing {
  /** Endpoints priced on both axes (listed rates with n=0 when the catalog is down). */
  n: number;
  inMed: number;
  outMed: number;
  crMed: number;
  youMed: number;
  youMin: number;
  youMax: number;
}

interface JoinedModel {
  orId: string;
  name: string;
  /** Listed model-level rates from /api/v1/models — not what ZDR routing charges. */
  listedPrompt: number;
  listedCompletion: number;
  listedCacheRead: number;
  listedCacheWrite: number;
  pricing: ModelPricing;
  context: number;
  maxOutput: number;
  inputTypes: string[];
  hasReasoning: boolean;
  hasTools: boolean;
  aaCoding?: number;
  aaIntel?: number;
  aaSpeed?: number;
  aaLatency?: number;
  aaMmluPro?: number;
  aaLiveCodeBench?: number;
  creator: string;
}

// ── CLI args ──

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    drift: { type: "boolean", default: false },
    local: { type: "boolean", default: false },
    model: { type: "string", default: [], short: "m", multiple: true },
    endpoints: { type: "string", default: [], short: "e", multiple: true },
    range: { type: "string", default: "" },
    quant: { type: "string", default: "" },
    json: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false, short: "v" },
    help: { type: "boolean", default: false, short: "h" },
  },
  strict: true,
  allowPositionals: true,
});

if (parsed.values.help) {
  console.log(
    `
${BOLD}model-scan${RESET} — discover LLM models, detect config drift, find local MLX options

${BOLD}USAGE${RESET}
  bun run scripts/model-scan.ts [options]

${BOLD}OPTIONS${RESET}
  --drift       Check current pi.nix config for price/spec drift
  --local       Find trending MLX models via oMLX admin API
  --model, -m   Estimate specific HF repo (repeatable, e.g. --model mlx-community/Qwen3.6-27B-4bit)
  --endpoints, -e  Fetch OpenRouter provider endpoints for a model (throughput/latency/pricing).
                  Repeatable and comma-separated: two or more -> cross-model comparison.
  --range         With --endpoints: window for traffic-weighted effective pricing
                  (default: today UTC; 1w | 1m | 3m | all)
  --quant           With --endpoints: comma-separated quantization filter (e.g. fp8,bf16)
  --json        Output machine-readable JSON instead of formatted table
  --quiet       Suppress status messages on stderr
  --verbose, -v Include low-scoring models in output
  --help, -h    Show this help message

${BOLD}DATA SOURCES${RESET}
  OpenRouter    /api/v1/models (public) + /api/v1/endpoints/zdr (global ZDR
                endpoint pricing) + /api/v1/models/user (account ZDR filter)
  AA            /api/v2/data/llms/models (benchmarks, speed, pricing) — full
                evaluation suite documented at https://artificialanalysis.ai/api-reference
  oMLX          Admin API at localhost:8124 (local MLX models, HF search)
  pi.nix        ~/.pi/agent/models.json (current config for drift check)
`.trim(),
  );
  process.exit(0);
}

const modeDrift = parsed.values.drift;
const modeLocal = parsed.values.local;
const modeModels = parsed.values.model;
// -e accepts repeats and commas: "-e a/b -e c/d" or "-e a/b,c/d"
const modeEndpointSlugs = (Array.isArray(parsed.values.endpoints) ? parsed.values.endpoints : [parsed.values.endpoints])
  .flatMap((s: string) => s.split(","))
  .map((s: string) => s.trim())
  .filter(Boolean);
const modeRange = parsed.values.range;
if (modeRange && !modeEndpointSlugs.length) {
  console.error(`${RED}--range only applies to --endpoints${RESET}`);
  process.exit(1);
}
if (modeRange && !["1w", "1m", "3m", "all"].includes(modeRange)) {
  console.error(`${RED}--range must be one of 1w, 1m, 3m, all (default: today UTC)${RESET}`);
  process.exit(1);
}
const modeJson = parsed.values.json;
const modeQuiet = parsed.values.quiet;
const verbose = parsed.values.verbose;

// ── Key resolution ──

function getOpenRouterKey(): string {
  try {
    return execSync(
      "op --account GZ5VHFHUKJGHPMLTD2PZ2MUUPI read 'op://oqpoo4svevbobqjgyniixhmqca/llm-api-keys/pi/openrouter-main'",
      { encoding: "utf-8" },
    ).trim();
  } catch {
    console.error(`${RED}OpenRouter key not found in 1Password (pi/openrouter-main)${RESET}`);
    process.exit(1);
  }
}

function getAAKey(): string {
  try {
    const key = execSync(
      "op --account GZ5VHFHUKJGHPMLTD2PZ2MUUPI read 'op://oqpoo4svevbobqjgyniixhmqca/llm-api-keys/generic/artificialanalysis'",
      {
        encoding: "utf-8",
      },
    ).trim();
    return key;
  } catch {
    console.error(`${RED}Artificial Analysis key not found in 1Password${RESET}`);
    process.exit(1);
  }
}

// ── Data fetching (with file cache) ──

const CACHE_DIR = join(homedir(), ".cache", "model-scan");
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
const ENDPOINT_CACHE_TTL = 1000 * 60 * 15; // 15 min — endpoint perf/availability drifts fast

function readCache<T>(name: string, ttlMs = CACHE_TTL): T | null {
  const p = join(CACHE_DIR, `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    const fs = require("node:fs");
    const s = fs.statSync(p);
    if (Date.now() - s.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeCache(name: string, data: unknown): void {
  const fs = require("node:fs");
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(join(CACHE_DIR, `${name}.json`), JSON.stringify(data));
}

async function fetchORModels(): Promise<ORModel[]> {
  const cached = readCache<ORModel[]>("or-models");
  if (cached) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached OpenRouter models${RESET}\n`);
    return cached;
  }
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching OpenRouter models...${RESET}\n`);
  const res = await fetch("https://openrouter.ai/api/v1/models");
  const data = (await res.json()) as { data: ORModel[] };
  writeCache("or-models", data.data);
  return data.data;
}

async function fetchORUserModels(key: string): Promise<Set<string>> {
  const cached = readCache<string[]>("or-user-ids");
  if (cached) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached ZDR models${RESET}\n`);
    return new Set(cached);
  }
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching ZDR-eligible models...${RESET}\n`);
  const res = await fetch("https://openrouter.ai/api/v1/models/user", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = (await res.json()) as { data: ORModel[] };
  const ids = data.data.map((m: ORModel) => m.id);
  writeCache("or-user-ids", ids);
  return new Set(ids);
}

async function fetchAAModels(key: string): Promise<AAModel[]> {
  const cached = readCache<AAModel[]>("aa-models");
  if (cached) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached Artificial Analysis benchmarks${RESET}\n`);
    return cached;
  }
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching Artificial Analysis benchmarks...${RESET}\n`);
  const res = await fetch("https://artificialanalysis.ai/api/v2/data/llms/models", {
    headers: { "x-api-key": key },
  });
  const data = (await res.json()) as { data: AAModel[] };
  writeCache("aa-models", data.data);
  return data.data;
}

function loadPiConfig(): PiModelsFile | null {
  const path = join(homedir(), ".pi", "agent", "models.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ── Join logic ──

function buildAALookup(aaModels: AAModel[]): Map<string, AAModel> {
  const lookup = new Map<string, AAModel>();
  for (const m of aaModels) {
    // Index by slug (e.g. "deepseek-v4-flash")
    lookup.set(m.slug, m);
    // Also index by "creator/slug" pattern
    if (m.model_creator?.slug) {
      lookup.set(`${m.model_creator.slug}/${m.slug}`, m);
    }
  }
  return lookup;
}

function joinORWithAA(orModel: ORModel, aaLookup: Map<string, AAModel>): AAModel | undefined {
  const parts = orModel.id.split("/");
  const slug = (parts.length > 1 ? parts[parts.length - 1] : orModel.id) ?? orModel.id;
  const normalized = slug.replace(/\./g, "-");
  const creatorPart = parts[0] ?? "";
  return (
    aaLookup.get(slug) ??
    aaLookup.get(orModel.id) ??
    aaLookup.get(normalized) ??
    aaLookup.get(parts.length > 1 ? `${creatorPart}/${normalized}` : normalized)
  );
}

function parsePrice(p: string): number {
  const v = parseFloat(p);
  if (v <= 0) return NaN; // "-1" is OpenRouter sentinel for dynamic/auto-routing pricing
  return v * 1_000_000;
}

/** Price-per-token-string -> $/M; absent/unset fields become NaN. */
function optPrice(p: string | undefined): number {
  return p == null ? NaN : parsePrice(p);
}

// ── Real-workload pricing (your pi sessions, last 30d) ──

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
const WORKLOAD_WINDOW_MS = 1000 * 60 * 60 * 24 * 30;

interface SessionWorkload {
  input: number; // uncached prompt tokens
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reqs: number;
  recordedCost: number;
  coverMs: number; // span between first and last counted message
  byModel: Map<string, { reqs: number; cost: number }>; // recorded spend per model id
}

/** Aggregate token volumes actually served across all pi session files in the
 * window. Per-message cost totals ride along as the real-spend baseline. */
function loadSessionWorkload(): SessionWorkload | null {
  const cutoff = Date.now() - WORKLOAD_WINDOW_MS;
  let projDirs: string[];
  try {
    projDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(SESSIONS_DIR, d.name));
  } catch {
    return null;
  }
  const agg = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reqs: 0,
    recordedCost: 0,
    coverMs: 0,
    byModel: new Map<string, { reqs: number; cost: number }>(),
  };
  let minTs = Infinity;
  let maxTs = 0;
  for (const dir of projDirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      // unreadable dir — skip
    }
    for (const f of files) {
      const p = join(dir, f);
      let lines: string[] = [];
      try {
        if (statSync(p).mtimeMs < cutoff) continue;
        lines = readFileSync(p, "utf-8").split("\n");
      } catch {
        continue;
      }
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let e: {
          type?: string;
          timestamp?: string;
          message?: {
            role?: string;
            model?: string;
            usage?: {
              input?: number;
              output?: number;
              cacheRead?: number;
              cacheWrite?: number;
              totalTokens?: number;
              cost?: { total?: number };
            };
          };
        };
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const u = e.message?.role === "assistant" ? e.message?.usage : undefined;
        if (!u?.totalTokens) continue;
        agg.input += u.input ?? 0;
        agg.output += u.output ?? 0;
        agg.cacheRead += u.cacheRead ?? 0;
        agg.cacheWrite += u.cacheWrite ?? 0;
        agg.reqs++;
        agg.recordedCost += u.cost?.total ?? 0;
        const mid = e.message?.model ?? "?";
        const bm = agg.byModel.get(mid) ?? { reqs: 0, cost: 0 };
        bm.reqs++;
        bm.cost += u.cost?.total ?? 0;
        agg.byModel.set(mid, bm);
        const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
        if (Number.isFinite(ts)) {
          if (ts < minTs) minTs = ts;
          if (ts > maxTs) maxTs = ts;
        }
      }
    }
  }
  if (agg.reqs === 0) return null;
  agg.coverMs = Number.isFinite(minTs) && maxTs > minTs ? maxTs - minTs : WORKLOAD_WINDOW_MS;
  return agg;
}

/** Your 30d pi workload priced at one endpoint's listed rates. Cache read
 * falls back to the input rate when unlisted; cache write likewise. NaN when
 * the endpoint's input price is dynamic. */
function youMoOf(e: OREndpoint, wl: SessionWorkload | null, scale: number): number {
  if (!wl) return NaN;
  const pin = parsePrice(e.pricing.prompt);
  const pout = parsePrice(e.pricing.completion);
  if (!Number.isFinite(pin) || !Number.isFinite(pout)) return NaN;
  const pcr = optPrice(e.pricing.input_cache_read);
  const pcw = optPrice(e.pricing.input_cache_write);
  const r = Number.isFinite(pcr) ? pcr : pin;
  const w = Number.isFinite(pcw) ? pcw : pin;
  return ((wl.input * pin + wl.cacheRead * r + wl.cacheWrite * w + wl.output * pout) / 1e6) * scale;
}

/** ZDR price stats for one model from its up endpoints: per-axis medians over
 * the endpoints listing both rates (Cr/M over those that also list cache-read)
 * plus the your-mix monthly range across endpoints. Endpoints are the ones
 * listing both rates — free/dynamic rows drop out — so n, the your-mix range,
 * and the admission check in the caller all describe one set. Null when
 * nothing is priced. */
function zdrPricing(eps: OREndpoint[], wl: SessionWorkload | null, scale: number): ModelPricing | null {
  const priced = eps.filter(
    (e) => Number.isFinite(parsePrice(e.pricing.prompt)) && Number.isFinite(parsePrice(e.pricing.completion)),
  );
  if (priced.length === 0) return null;
  const yous = priced.map((e) => youMoOf(e, wl, scale)).filter((v) => Number.isFinite(v));
  return {
    n: priced.length,
    inMed: priceStats(priced.map((e) => parsePrice(e.pricing.prompt)))?.med ?? NaN,
    outMed: priceStats(priced.map((e) => parsePrice(e.pricing.completion)))?.med ?? NaN,
    crMed: priceStats(priced.map((e) => optPrice(e.pricing.input_cache_read)))?.med ?? NaN,
    youMed: median(yous),
    youMin: yous.length > 0 ? Math.min(...yous) : NaN,
    youMax: yous.length > 0 ? Math.max(...yous) : NaN,
  };
}

/** Catalog-down fallback: model-level listed rates in the same shape, n=0
 * marking "no endpoint data". Null when the listed price is free/dynamic. */
function listedPricing(m: ORModel, wl: SessionWorkload | null, scale: number): ModelPricing | null {
  const i = parsePrice(m.pricing.prompt);
  const o = parsePrice(m.pricing.completion);
  if (!Number.isFinite(i) || !Number.isFinite(o)) return null;
  const r = optPrice(m.pricing.input_cache_read);
  const w = optPrice(m.pricing.input_cache_write);
  const cr = Number.isFinite(r) ? r : i;
  const cw = Number.isFinite(w) ? w : i;
  const youMed =
    wl != null ? ((wl.input * i + wl.cacheRead * cr + wl.cacheWrite * cw + wl.output * o) / 1e6) * scale : NaN;
  return { n: 0, inMed: i, outMed: o, crMed: r, youMed, youMin: NaN, youMax: NaN };
}

// ── Formatting helpers ──

function fmtPrice(p: number): string {
  if (Number.isNaN(p)) return "(dynamic)";
  if (p < 0.001) return `$${p.toFixed(4)}`;
  if (p < 1) return `$${p.toFixed(3)}`;
  return `$${p.toFixed(2)}`;
}

/** "min–max" for the You/mo range column, whole dollars once both bounds are
 * past $1 (a flat range renders as the single value); a sub-dollar bound keeps
 * every bound exact so the pair cannot render inverted. */
function fmtPriceRange(lo: number, hi: number): string {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return `${DIM}--${RESET}`;
  const a = lo >= 1 && hi >= 1 ? `$${Math.round(lo)}` : fmtPrice(lo);
  const b = lo >= 1 && hi >= 1 ? `$${Math.round(hi)}` : fmtPrice(hi);
  return a === b ? a : `${a}–${b}`;
}

function fmtScore(v: number | undefined | null, width = 5): string {
  if (v == null) return `${DIM}${"".padStart(width)}${RESET}`;
  const s = v.toFixed(1);
  if (v >= 45) return `${GREEN}${s.padStart(width)}${RESET}`;
  if (v >= 30) return `${YELLOW}${s.padStart(width)}${RESET}`;
  return `${DIM}${s.padStart(width)}${RESET}`;
}

function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function fmtInput(types: string[]): string {
  if (types.includes("image")) return "txt+img";
  return "txt";
}

/** AA-style 3:1 blend: (1×input + 3×output)/4. NaN when either side dynamic/free. */
function blend31(promptPerM: number, completionPerM: number): number {
  if (!Number.isFinite(promptPerM) || !Number.isFinite(completionPerM)) return NaN;
  return (promptPerM + 3 * completionPerM) / 4;
}

// Column heat: top third green, middle yellow, rest plain. Thresholds are
// terciles of the fetched data, not constants — distributions shift.
type Tier = "g" | "y" | "";
function paint(s: string, tier: Tier): string {
  if (tier === "g") return `${GREEN}${s}${RESET}`;
  if (tier === "y") return `${YELLOW}${s}${RESET}`;
  return s;
}

function makeTiers(values: number[], lowerBetter = false): (v: number) => Tier {
  const scores = values
    .filter(Number.isFinite)
    .map((v) => (lowerBetter ? -v : v))
    .sort((a, b) => a - b);
  if (scores.length === 0) return () => "";
  // Rank-fraction tiers (not thresholds): robust for tiny rowsets and ties.
  return (v: number): Tier => {
    if (!Number.isFinite(v)) return "";
    const n = lowerBetter ? -v : v;
    let below = 0;
    for (const s of scores) if (s < n) below++;
    const frac = scores.length > 1 ? below / (scores.length - 1) : 1;
    return frac >= 2 / 3 ? "g" : frac >= 1 / 3 ? "y" : "";
  };
}

// ── Local model estimation ──

const SYSTEM_OVERHEAD_GB = 8; // macOS + apps + oMLX overhead

interface ModelEstimate {
  type: "dense" | "moe";
  tokPerSec: number;
  tokConfidence: "high" | "medium" | "low";
  headroomGB: number;
  comfort: "comfortable" | "tight" | "cramped" | "overflow";
}

function getSystemRAMGB(): number {
  try {
    const memsize = execSync("sysctl -n hw.memsize", { encoding: "utf-8" }).trim();
    return Math.round(parseInt(memsize, 10) / 1024 ** 3);
  } catch {
    return 48;
  }
}

/**
 * Estimate generation performance on Apple Silicon.
 *
 * Dense models: memory-bandwidth bound, tok/s scales inversely with size.
 * MoE models: only active experts loaded per token. Scaling follows
 *   tok/s = dense_ref * (total_params / active_params)^0.35
 * The exponent < 1 captures routing overhead that partially offsets sparsity benefit.
 * Calibrated against measured: 35B-A3B-UD at ~36.5 tok/s.
 *
 * Known benchmarks (dense) from oMLX community, M4 Pro 16c:
 */
function estimateModel(sizeBytes: number, repoId: string, totalRAMGB: number): ModelEstimate {
  const sizeGB = sizeBytes / 1e9;
  const available = totalRAMGB - SYSTEM_OVERHEAD_GB;
  const headroomGB = Math.round((available - sizeGB) * 10) / 10;
  const lower = repoId.toLowerCase();

  const isMoE = /a[34]b|[_-]moe/i.test(lower);
  const type = isMoE ? ("moe" as const) : ("dense" as const);

  // Extract parameter counts from repo ID for MoE models.
  // Patterns: "35B-A3B" (total 35B, active 3B), "26B-A4B" (total 26B, active 4B)
  // Also handles: "30B-A3B", "48B-A3B", "21B-A3B" etc.
  const totalMatch = lower.match(/(\d+(?:\.\d+)?)b[._-]a(\d+(?:\.\d+)?)b/);
  const moeMatch = lower.match(/a(\d+(?:\.\d+)?)b/);
  const totalParamsB = totalMatch?.[1] ? parseFloat(totalMatch[1]) : null;
  const activeParamsB =
    totalParamsB && totalMatch?.[2] ? parseFloat(totalMatch[2]) : moeMatch?.[1] ? parseFloat(moeMatch[1]) : null;

  // Known dense benchmarks: [pattern, tokPerSec, refSizeGB]
  const denseRefs: Array<[RegExp, number, number]> = [
    [/qwen3\.6-27b/i, 15.1, 15.0],
    [/qwen3\.5-27b/i, 14.8, 15.0],
    [/gemma-4-31b/i, 10.2, 17.1],
    [/qwen3\.5-9b/i, 48.0, 5.5],
    [/glm-4\.7/i, 14.0, 23.8],
    [/llama-3\.2-1b/i, 120, 0.7],
    [/qwen2\.5-0\.5b/i, 180, 0.3],
  ];

  let tokPerSec: number;
  let tokConfidence: ModelEstimate["tokConfidence"];

  const known = denseRefs.find(([pat]) => pat.test(lower));
  if (known) {
    tokPerSec = known[1] * (known[2] / sizeGB);
    tokConfidence = "high";
  } else if (isMoE && activeParamsB && totalParamsB) {
    // MoE: compute-based estimate.
    // Generation = attention + MLP + KV-cache overhead.
    // MLP scales with active params; attention/KV are fixed per architecture.
    // speedup = 1 / (1 - mlp_share + mlp_share * (active/total))
    // Calibrated against measured: 35B-A3B-UD at 36.5 tok/s.
    // UD variant is ~1.7x faster than standard 4-bit (kernel optimizations).
    // So standard 4-bit 35B-A3B baseline = 36.5 / 1.7 = 21.5 tok/s.
    const mlpShare = 0.5;
    const udRefTok = 36.5; // measured: Qwen3.6-35B-A3B-UD
    const udToStdFactor = 1.7; // UD ~1.7x faster than standard 4-bit
    const stdRefAtSize = udRefTok / udToStdFactor; // 21.5 tok/s for standard 4-bit
    const speedup = 1 / (1 - mlpShare + mlpShare * (activeParamsB / totalParamsB));
    tokPerSec = stdRefAtSize * speedup;
    tokConfidence = "medium";
  } else if (isMoE) {
    // MoE without known active params -- rough guess
    tokPerSec = 30;
    tokConfidence = "low";
  } else {
    // Scale from Qwen 27B reference (best dense reference point)
    tokPerSec = 15.1 * (15.0 / sizeGB);
    tokConfidence = "medium";
  }

  let comfort: ModelEstimate["comfort"];
  if (headroomGB < 0) comfort = "overflow";
  else if (headroomGB < 6) comfort = "cramped";
  else if (headroomGB < 14) comfort = "tight";
  else comfort = "comfortable";

  return { type, tokPerSec: Math.round(tokPerSec), tokConfidence, headroomGB, comfort };
}

function fmtComfort(c: ModelEstimate["comfort"]): string {
  switch (c) {
    case "comfortable":
      return `${GREEN}ok${RESET}`;
    case "tight":
      return `${YELLOW}tight${RESET}`;
    case "cramped":
      return `${RED}tight${RESET}`;
    case "overflow":
      return `${RED}NO${RESET}`;
  }
}

function fmtEstTokPerSec(est: ModelEstimate): string {
  const s = `${est.tokPerSec}`;
  switch (est.tokConfidence) {
    case "high":
      return `${GREEN}${s}${RESET}`;
    case "medium":
      return `${YELLOW}~${s}${RESET}`;
    case "low":
      return `${DIM}?${s}${RESET}`;
  }
}

// ── Discover mode ──

async function discover(): Promise<void> {
  const orKey = getOpenRouterKey();
  const aaKey = getAAKey();

  const [orModels, zdrIds, zdrCatalog, aaModels] = await Promise.all([
    fetchORModels(),
    fetchORUserModels(orKey),
    fetchZdrCatalog(orKey),
    fetchAAModels(aaKey),
  ]);

  const aaLookup = buildAALookup(aaModels);

  // Your actual pi traffic (last 30d of session logs), drives You/mo + its range.
  const wl = loadSessionWorkload();
  const wlScale = wl ? WORKLOAD_WINDOW_MS / Math.max(wl.coverMs, 1000 * 60 * 60 * 24) : 1;

  // Eligibility needs both: /models/user is the account filter (privacy
  // settings, provider prefs, guardrails), /endpoints/zdr is global. With the
  // catalog down, eligible models keep their listed rates.
  const catalogOk = zdrCatalog.tags.size > 0;
  if (!catalogOk) {
    process.stderr.write(
      `${YELLOW}Warning: ZDR endpoint catalog unavailable — prices fall back to listed model rates.${RESET}\n`,
    );
  }

  // Filter: ZDR-eligible for this account, priced, text input
  const candidates: JoinedModel[] = [];

  for (const m of orModels) {
    if (!m.architecture.input_modalities.includes("text")) continue;
    if (!zdrIds.has(m.id)) continue;
    const routable = (zdrCatalog.byModel.get(m.id) ?? []).filter((e) => e.status === 0);
    const pricing = catalogOk ? zdrPricing(routable, wl, wlScale) : listedPricing(m, wl, wlScale);
    if (!pricing) continue;

    const aa = joinORWithAA(m, aaLookup);
    const maxOut = m.top_provider.max_completion_tokens ?? 0;

    candidates.push({
      orId: m.id,
      name: m.name,
      listedPrompt: parsePrice(m.pricing.prompt),
      listedCompletion: parsePrice(m.pricing.completion),
      listedCacheRead: optPrice(m.pricing.input_cache_read),
      listedCacheWrite: optPrice(m.pricing.input_cache_write),
      pricing,
      context: m.context_length ?? 0,
      maxOutput: maxOut,
      inputTypes: m.architecture.input_modalities,
      hasReasoning:
        m.supported_parameters.includes("reasoning") || m.supported_parameters.includes("include_reasoning"),
      hasTools: m.supported_parameters.includes("tools"),
      aaCoding: aa?.evaluations?.artificial_analysis_coding_index ?? undefined,
      aaIntel: aa?.evaluations?.artificial_analysis_intelligence_index ?? undefined,
      aaSpeed: aa?.median_output_tokens_per_second ?? undefined,
      aaLatency: aa?.median_time_to_first_token_seconds ?? undefined,
      aaMmluPro: aa?.evaluations?.mmlu_pro ?? undefined,
      aaLiveCodeBench: aa?.evaluations?.livecodebench ?? undefined,
      creator: m.id.split("/")[0] ?? "",
    });
  }

  // Sort by coding index descending (models without benchmarks go last)
  candidates.sort((a, b) => (b.aaCoding ?? -1) - (a.aaCoding ?? -1));

  if (modeJson) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }

  // ── Print table ──
  // Every comparable column gets heat tiers at its own terciles.
  const valueScore = (m: JoinedModel): number => {
    const b = blend31(m.pricing.inMed, m.pricing.outMed);
    return m.aaCoding != null && Number.isFinite(b) ? m.aaCoding / b : NaN;
  };
  const tiers = {
    coding: makeTiers(candidates.map((m) => m.aaCoding ?? NaN)),
    intel: makeTiers(candidates.map((m) => m.aaIntel ?? NaN)),
    speed: makeTiers(candidates.map((m) => m.aaSpeed ?? NaN)),
    inPrice: makeTiers(
      candidates.map((m) => m.pricing.inMed),
      true,
    ),
    outPrice: makeTiers(
      candidates.map((m) => m.pricing.outMed),
      true,
    ),
    cacheR: makeTiers(
      candidates.map((m) => m.pricing.crMed),
      true,
    ),
    ctx: makeTiers(candidates.map((m) => m.context)),
    value: makeTiers(candidates.map(valueScore)),
    you: makeTiers(
      candidates.map((m) => m.pricing.youMed),
      true,
    ),
  };

  const tableRows = candidates
    .filter((m) => (m.aaCoding ?? 0) >= 15 || verbose)
    .map((m) => {
      const v = valueScore(m);
      return {
        Model: m.orId,
        Coding:
          m.aaCoding != null
            ? paint(m.aaCoding.toFixed(1).padStart(5), tiers.coding(m.aaCoding))
            : `${DIM}${"".padStart(5)}${RESET}`,
        Intel:
          m.aaIntel != null
            ? paint(m.aaIntel.toFixed(1).padStart(5), tiers.intel(m.aaIntel))
            : `${DIM}${"".padStart(5)}${RESET}`,
        Speed:
          m.aaSpeed != null ? paint(m.aaSpeed.toFixed(0).padStart(4), tiers.speed(m.aaSpeed)) : `${DIM}   --${RESET}`,
        "In/M": Number.isFinite(m.pricing.inMed)
          ? paint(fmtPrice(m.pricing.inMed), tiers.inPrice(m.pricing.inMed))
          : "(dynamic)",
        "Out/M": Number.isFinite(m.pricing.outMed)
          ? paint(fmtPrice(m.pricing.outMed), tiers.outPrice(m.pricing.outMed))
          : "(dynamic)",
        "Cr/M": Number.isFinite(m.pricing.crMed)
          ? paint(fmtPrice(m.pricing.crMed), tiers.cacheR(m.pricing.crMed))
          : `${DIM}--${RESET}`,
        N: m.pricing.n > 0 ? String(m.pricing.n) : `${DIM}--${RESET}`,
        "You/mo": Number.isFinite(m.pricing.youMed)
          ? paint(fmtPrice(m.pricing.youMed), tiers.you(m.pricing.youMed))
          : "(dyn)",
        "You rng": m.pricing.n > 1 ? fmtPriceRange(m.pricing.youMin, m.pricing.youMax) : `${DIM}--${RESET}`,
        Value: Number.isFinite(v) ? paint(v.toFixed(0), tiers.value(v)) : `${DIM}--${RESET}`,
        Ctx: paint(fmtCtx(m.context), tiers.ctx(m.context)),
        "I/O": fmtInput(m.inputTypes),
        Tools: `${m.hasTools ? `${GREEN}✓${RESET}` : `${DIM}✗${RESET}`}${m.hasReasoning ? ` ${CYAN}R${RESET}` : ""}`,
      };
    });

  if (wl) {
    const covD = Math.max(1, Math.round(wl.coverMs / 86_400_000));
    const inTok = wl.input + wl.cacheRead + wl.cacheWrite;
    const hit = inTok > 0 ? `${((wl.cacheRead / inTok) * 100).toFixed(0)}% cache hit` : "no cached input";
    console.log(
      `${DIM}Your pi workload: ${wl.reqs} reqs / ${covD}d, ${hit} — ${humanTokens(wl.input)} uncached in · ${humanTokens(wl.cacheRead)} cached · ${humanTokens(wl.output)} out · recorded $${wl.recordedCost.toFixed(2)} → $${(wl.recordedCost * wlScale).toFixed(2)}/mo. You/mo = that workload on one model.${RESET}`,
    );
    const spend = [...wl.byModel.entries()]
      .map(([id, v]) => ({ id, mo: v.cost * wlScale }))
      .filter((s) => s.mo > 0)
      .sort((a, b) => b.mo - a.mo)
      .slice(0, 3);
    if (spend.length > 0) {
      console.log(
        `${DIM}Top spenders (recorded): ${spend.map((s) => `${s.id} $${s.mo.toFixed(2)}/mo`).join(" · ")}${RESET}`,
      );
    }
  }
  const pricingNote = catalogOk
    ? `medians over N priced ZDR endpoints · You rng = your mix's min–max $/mo`
    : `ZDR endpoint catalog unavailable — listed model-level rates, which zdr=true may not reach`;
  console.log(
    `\n${BOLD}ZDR-eligible models ranked by coding quality${RESET}  ${DIM}(${tableRows.length} models; ${pricingNote})${RESET}`,
  );
  console.log(
    Bun.inspect.table(tableRows, [
      "Model",
      "Coding",
      "Intel",
      "Speed",
      "In/M",
      "Out/M",
      "Cr/M",
      "N",
      "You/mo",
      "You rng",
      "Value",
      "Ctx",
      "I/O",
      "Tools",
    ]),
  );

  // ── Highlights ──
  console.log(`\n${BOLD}Highlights${RESET}`);

  // Best coding for cheap (< $1/M input)
  const cheap = candidates.filter((m) => m.pricing.inMed < 1 && m.aaCoding != null);
  const bestCheap = cheap[0];
  if (bestCheap) {
    console.log(
      `  Best cheap coding: ${CYAN}${bestCheap.orId}${RESET} (coding=${bestCheap.aaCoding}, ${fmtPrice(bestCheap.pricing.inMed)}/M in)`,
    );
  }

  // Best coding overall
  const withCoding = candidates.filter((m) => m.aaCoding != null);
  const bestOverall = withCoding[0];
  if (bestOverall) {
    console.log(`  Best coding overall: ${CYAN}${bestOverall.orId}${RESET} (coding=${bestOverall.aaCoding})`);
  }

  // Fastest with decent quality
  const decent = candidates.filter((m) => (m.aaCoding ?? 0) >= 25 && m.aaSpeed != null);
  if (decent.length > 0) {
    decent.sort((a, b) => (b.aaSpeed ?? 0) - (a.aaSpeed ?? 0));
    const fastest = decent[0];
    if (fastest) {
      console.log(
        `  Fastest decent quality: ${CYAN}${fastest.orId}${RESET} (${fastest.aaSpeed} tok/s, coding=${fastest.aaCoding})`,
      );
    }
  }

  // Best value overall: coding index per blended 3:1 dollar.
  const valuedModels = candidates
    .map((m) => ({ m, v: m.aaCoding != null ? m.aaCoding / blend31(m.pricing.inMed, m.pricing.outMed) : NaN }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v);
  const bestValue = valuedModels[0];
  if (bestValue) {
    console.log(
      `  Best value: ${CYAN}${bestValue.m.orId}${RESET} (${bestValue.v.toFixed(0)} coding-pts per blended-$, coding=${bestValue.m.aaCoding})`,
    );
  }

  // Best value when cache reads dominate spend — long agentic sessions run
  // most prompt tokens through the cache (e.g. ~85% fleet-wide for V4 Flash).
  const cachedValued = candidates
    .map((m) => ({ m, v: m.aaCoding != null && m.pricing.crMed > 0 ? m.aaCoding / m.pricing.crMed : NaN }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => b.v - a.v);
  const bestCached = cachedValued[0];
  if (bestCached) {
    console.log(
      `  Best mostly-cached value: ${CYAN}${bestCached.m.orId}${RESET} (${bestCached.v.toFixed(0)} coding pts per cache-read-$${bestCached.m.pricing.inMed > bestCached.m.pricing.crMed * 100 ? `, cache read is ${(bestCached.m.pricing.inMed / bestCached.m.pricing.crMed).toFixed(0)}x cheaper than fresh input` : ""})`,
    );
  }

  // Cheapest models for your observed traffic mix: top 3 with a quality bar,
  // then the single cheapest regardless of quality.
  // "Good quality" = top-third coder on today's list (rank-fraction ≥ 2/3,
  // same rule the Coding column heat uses) — the bar moves with the frontier.
  const codingSorted = candidates
    .map((m) => m.aaCoding)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const goodBar =
    codingSorted.length > 0
      ? (codingSorted[Math.min(codingSorted.length - 1, Math.ceil(((codingSorted.length - 1) * 2) / 3))] ?? 0)
      : 0;
  const mixRanked = candidates
    .map((m) => ({ m, c: m.pricing.youMed }))
    .filter((x) => Number.isFinite(x.c))
    .sort((a, b) => a.c - b.c);
  const goodCheap = mixRanked.filter((x) => (x.m.aaCoding ?? 0) >= goodBar).slice(0, 3);
  if (goodCheap.length > 0) {
    console.log(`  Cheapest good quality (coding ≥ ${goodBar.toFixed(0)}, top third today) for your mix:`);
    for (const [i, x] of goodCheap.entries()) {
      console.log(`    ${i + 1}. ${CYAN}${x.m.orId}${RESET} ~${fmtPrice(x.c)}/mo (coding=${x.m.aaCoding?.toFixed(1)})`);
    }
  }
  const cheapestMix = mixRanked[0];
  if (cheapestMix) {
    console.log(
      `  Cheapest overall for your mix: ${CYAN}${cheapestMix.m.orId}${RESET} (~${fmtPrice(cheapestMix.c)}/mo)`,
    );
  }

  // 1M context with benchmarks
  const bigCtx = candidates.filter((m) => m.context >= 900_000 && m.aaCoding != null);
  if (bigCtx.length > 0) {
    bigCtx.sort((a, b) => (b.aaCoding ?? 0) - (a.aaCoding ?? 0));
    const bestCtx = bigCtx[0];
    if (bestCtx) {
      console.log(
        `  Best 1M context: ${CYAN}${bestCtx.orId}${RESET} (coding=${bestCtx.aaCoding}, ${fmtCtx(bestCtx.context)})`,
      );
    }
  }
}

// ── Drift mode ──

async function drift(): Promise<void> {
  const piConfig = loadPiConfig();
  if (!piConfig) {
    console.error(`${RED}No pi config found at ~/.pi/agent/models.json${RESET}`);
    process.exit(1);
  }

  const [orModels, aaModels] = await Promise.all([fetchORModels(), fetchAAModels(getAAKey())]);

  const orLookup = new Map(orModels.map((m) => [m.id, m]));
  const aaLookup = buildAALookup(aaModels);

  console.log(`\n${BOLD}Config drift check${RESET}\n`);

  for (const [providerName, provider] of Object.entries(piConfig.providers)) {
    for (const model of provider.models) {
      const isOpenRouter = providerName.startsWith("openrouter");
      const orId = model.id; // OR model IDs are like "deepseek/deepseek-v3.2", not "openrouter-main/deepseek/..."
      const orModel = isOpenRouter ? orLookup.get(orId) : undefined;

      if (isOpenRouter) {
        if (!orModel) {
          console.log(`  ${RED}MISSING${RESET} ${orId} -- not found on OpenRouter`);
          continue;
        }

        // Price check
        const prompt = parsePrice(orModel.pricing.prompt);
        const completion = parsePrice(orModel.pricing.completion);

        const priceStr = Number.isNaN(prompt) ? "(dynamic)" : `${fmtPrice(prompt)}/${fmtPrice(completion)} per M`;

        console.log(`  ${orId}`);
        console.log(
          `    Current: ${priceStr}  ctx=${fmtCtx(orModel.context_length ?? 0)}  max_out=${orModel.top_provider.max_completion_tokens ?? "?"}`,
        );

        // AA benchmarks if available
        const aa = joinORWithAA(orModel, aaLookup);
        if (aa?.evaluations) {
          const e = aa.evaluations;
          const parts: string[] = [];
          if (e.artificial_analysis_coding_index != null) parts.push(`coding=${e.artificial_analysis_coding_index}`);
          if (e.artificial_analysis_intelligence_index != null)
            parts.push(`intel=${e.artificial_analysis_intelligence_index}`);
          if (aa.median_output_tokens_per_second != null)
            parts.push(`speed=${aa.median_output_tokens_per_second.toFixed(0)}tok/s`);
          if (parts.length > 0) {
            console.log(`    Benchmarks: ${parts.join("  ")}`);
          }
        }

        // Check for newer/better models from same creator
        const currentAa = joinORWithAA(orModel, aaLookup);
        if (currentAa?.model_creator && currentAa?.evaluations) {
          const currentCreator = currentAa.model_creator.slug;
          const currentCoding = currentAa.evaluations.artificial_analysis_coding_index ?? 0;
          const currentDate = currentAa.release_date;

          const betterModels = aaModels
            .filter(
              (m) =>
                m.model_creator.slug === currentCreator &&
                (m.evaluations.artificial_analysis_coding_index ?? 0) > currentCoding &&
                (m.release_date ?? "") > (currentDate ?? ""),
            )
            .sort(
              (a, b) =>
                (b.evaluations.artificial_analysis_coding_index ?? 0) -
                (a.evaluations.artificial_analysis_coding_index ?? 0),
            )
            .slice(0, 3);

          for (const bm of betterModels) {
            const orMatch = orLookup.get(bm.slug) ?? orLookup.get(bm.name);
            const price = orMatch
              ? fmtPrice(parsePrice(orMatch.pricing.prompt))
              : fmtPrice(bm.pricing.price_1m_input_tokens);
            console.log(
              `    ${YELLOW}Better?${RESET} ${bm.name} (coding=${bm.evaluations.artificial_analysis_coding_index}, ${price}/M in)`,
            );
          }
        }
      } else {
        // Local provider -- just report
        console.log(`  ${DIM}${orId}${RESET} (local/provider, not checked)`);
      }
    }
  }
}

// ── Endpoints mode ──

interface OREndpoint {
  name: string;
  model_id?: string;
  provider_name: string;
  tag: string;
  quantization: string | null;
  status: number;
  context_length: number;
  is_byok: boolean;
  pricing: { prompt: string; completion: string; input_cache_read?: string; input_cache_write?: string };
  throughput_last_30m: { p50: number; p75: number; p90: number; p99: number } | null;
  latency_last_30m: { p50: number; p75: number; p90: number; p99: number } | null;
  uptime_last_5m: number | null;
  uptime_last_30m: number | null;
  uptime_last_1d: number | null;
}

interface ZdrCatalog {
  byModel: Map<string, OREndpoint[]>;
  zdr: Set<string>; // model_id|tag
  tags: Set<string>; // tag-only fallback
}

type ZdrInfo = ZdrCatalog;

interface EndpointFetch {
  slug: string;
  id: string;
  name: string;
  eps: OREndpoint[];
}

const RANGE_LABELS: Record<string, string> = {
  "": "today",
  "1w": "7 days",
  "1m": "30 days",
  "3m": "90 days",
  all: "all time",
};

interface EffProviderSummary {
  endpointId: string;
  providerName: string;
  providerSlug: string;
  effectiveInputPrice: number;
  effectiveOutputPrice: number;
  cacheHitRate: number;
  totalTokens: number;
}

// Traffic-weighted "price actually paid" per $/M from OpenRouter's frontend
// stats API (unofficial — not in openapi.json). Prices are $/M. Empty
// providerSummaries = no routed traffic in the window (typical for brand-new
// or zero-demand models).
interface EffPricing {
  weightedInputPrice: number;
  weightedOutputPrice: number;
  weightedCacheHitRate: number;
  providerSummaries: EffProviderSummary[];
}

async function fetchEffPricing(permaslug: string): Promise<EffPricing | null> {
  const cacheKey = `or-effp-${permaslug.replace(/\//g, "__")}${modeRange ? `-${modeRange}` : ""}`;
  const cached = readCache<EffPricing>(cacheKey, ENDPOINT_CACHE_TTL);
  if (cached) return cached;
  try {
    const url = `https://openrouter.ai/api/frontend/v1/stats/effective-pricing?permaslug=${encodeURIComponent(permaslug)}&shape=v7&variant=standard${modeRange ? `&range=${modeRange}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) {
      process.stderr.write(`${YELLOW}Warning: effective-pricing HTTP ${res.status} for ${permaslug}${RESET}\n`);
      return null;
    }
    const json = (await res.json()) as { data?: EffPricing; error?: unknown };
    const d = json.data;
    if (!d || !Array.isArray(d.providerSummaries)) {
      process.stderr.write(`${YELLOW}Warning: unexpected effective-pricing payload for ${permaslug}${RESET}\n`);
      return null;
    }
    writeCache(cacheKey, d);
    return d;
  } catch {
    process.stderr.write(`${YELLOW}Warning: effective-pricing unreachable for ${permaslug}${RESET}\n`);
    return null;
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? NaN;
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function humanTokens(t: number): string {
  if (t >= 1e12) return `${(t / 1e12).toFixed(1)}T`;
  if (t >= 1e9) return `${(t / 1e9).toFixed(1)}B`;
  if (t >= 1e6) return `${(t / 1e6).toFixed(1)}M`;
  return `${Math.round(t)}`;
}

/** Price stats over finite ($>0) entries only; free/dynamic excluded upstream. */
function priceStats(values: number[]): { med: number; avg: number; n: number } | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return { med: median(finite), avg: mean(finite), n: finite.length };
}

/** Routable-for-us endpoints: up, and ZDR-compliant when the ZDR list loaded. */
function pickRoutable(eps: OREndpoint[], zdrInfo: ZdrInfo): OREndpoint[] {
  const zdrKnown = zdrInfo.tags.size > 0;
  const isZdr = (e: OREndpoint): boolean =>
    (e.model_id != null && zdrInfo.zdr.has(`${e.model_id}|${e.tag}`)) || zdrInfo.tags.has(e.tag);
  return eps.filter((e) => e.status === 0 && (!zdrKnown || isZdr(e)));
}

/** "Effective pricing" summary lines; empty summaries = no traffic → say so. */
function effLines(eff: EffPricing | null): string[] {
  if (!eff) return [`  ${DIM}effective pricing: unavailable${RESET}`];
  if (eff.providerSummaries.length === 0) {
    return [`  ${DIM}effective pricing: no routed traffic in window${RESET}`];
  }
  const chr = eff.weightedCacheHitRate != null ? `${(eff.weightedCacheHitRate * 100).toFixed(0)}%` : "?";
  // weightedInputPrice is the price actually paid per input token — cache hits
  // billed at the (much lower) cache-read rate are already netted in.
  const head = `  Effective (${RANGE_LABELS[modeRange] ?? modeRange}): ${fmtPrice(eff.weightedInputPrice)}/M in (${chr} cache-hit, net) · ${fmtPrice(eff.weightedOutputPrice)}/M out`;
  const ps = [...eff.providerSummaries].sort((a, b) => b.totalTokens - a.totalTokens);
  const total = ps.reduce((a, p) => a + p.totalTokens, 0);
  const top = ps
    .slice(0, 4)
    .map(
      (p) =>
        `${p.providerName} ${total > 0 ? ((p.totalTokens / total) * 100).toFixed(0) : "?"}% ($${p.effectiveInputPrice.toFixed(3)}/$${p.effectiveOutputPrice.toFixed(3)})`,
    );
  const more = ps.length - 4 > 0 ? ` (+${ps.length - 4} more)` : "";
  const lines = [head, `  By volume: ${top.join(" · ")}${more}`];
  const blend = blend31(eff.weightedInputPrice, eff.weightedOutputPrice);
  if (Number.isFinite(blend)) {
    lines.push(`  Paid blend ((in)+3(out))/4 at those rates: ${fmtPrice(blend)}/M`);
  }
  return lines;
}

/** Index the catalog for ZDR checks: (model_id, tag) pairs with a tag-only
 * fallback, plus endpoints grouped by model. */
function buildZdrCatalog(endpoints: OREndpoint[]): ZdrCatalog {
  const zdr = new Set<string>();
  const tags = new Set<string>();
  const byModel = new Map<string, OREndpoint[]>();
  for (const e of endpoints) {
    if (e.model_id && e.tag) zdr.add(`${e.model_id}|${e.tag}`);
    if (e.tag) tags.add(e.tag);
    if (e.model_id) {
      const list = byModel.get(e.model_id);
      if (list) list.push(e);
      else byModel.set(e.model_id, [e]);
    }
  }
  return { byModel, zdr, tags };
}

// ZDR is provider-level: each endpoint's provider data policy decides whether
// prompts are retained. /endpoints/zdr returns every endpoint that survives
// ZDR enforcement, pricing and live status included — the default mode prices
// from it, the endpoints mode takes its ZDR column from it.

/** Catalog row shape: a non-null object with a tag and a prompt price. */
function catalogRowOk(row: unknown): boolean {
  const e = row as { pricing?: { prompt?: unknown }; tag?: unknown } | null | undefined;
  return e != null && typeof e.pricing?.prompt === "string" && typeof e.tag === "string";
}

/** Non-empty array of well-formed catalog rows (cached or fetched). */
function isZdrPayload(rows: unknown): rows is OREndpoint[] {
  return Array.isArray(rows) && rows.length > 0 && rows.every(catalogRowOk);
}

async function fetchZdrCatalog(key: string): Promise<ZdrCatalog> {
  const empty = (): ZdrCatalog => buildZdrCatalog([]);
  const cached = readCache<{ endpoints?: OREndpoint[] }>("or-zdr-endpoints", ENDPOINT_CACHE_TTL);
  const cachedEndpoints = cached?.endpoints;
  if (isZdrPayload(cachedEndpoints)) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached ZDR endpoint catalog${RESET}\n`);
    return buildZdrCatalog(cachedEndpoints);
  }
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching ZDR-compliant endpoints...${RESET}\n`);
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/endpoints/zdr", {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    process.stderr.write(`${YELLOW}Warning: could not fetch /endpoints/zdr (network) — ZDR data omitted.${RESET}\n`);
    return empty();
  }
  if (!res.ok) {
    process.stderr.write(
      `${YELLOW}Warning: /endpoints/zdr failed (HTTP ${res.status}) — requires auth; using provided key. ZDR data omitted.${RESET}\n`,
    );
    return empty();
  }
  let data: unknown;
  try {
    data = (await res.json()) as { data?: unknown };
  } catch {
    process.stderr.write(`${YELLOW}Warning: /endpoints/zdr returned non-JSON — ZDR data omitted.${RESET}\n`);
    return empty();
  }
  const arr = (data as { data?: unknown }).data;
  if (!isZdrPayload(arr)) {
    process.stderr.write(
      `${YELLOW}Warning: /endpoints/zdr returned an unexpected payload — ZDR data omitted.${RESET}\n`,
    );
    return empty();
  }
  writeCache("or-zdr-endpoints", { endpoints: arr });
  return buildZdrCatalog(arr);
}

async function fetchModelEndpoints(slug: string, key: string): Promise<EndpointFetch> {
  const cacheKey = `or-endpoints-${slug.replace(/\//g, "__")}`;
  const cached = readCache<EndpointFetch>(cacheKey, ENDPOINT_CACHE_TTL);
  if (cached?.eps?.length) {
    if (!modeQuiet) process.stderr.write(`${DIM}Using cached endpoints for ${slug}${RESET}\n`);
    return cached;
  }
  const [author, model] = slug.split("/");
  if (!author || !model) {
    throw new Error(`-e expects "author/slug", got "${slug}" (e.g. deepseek/deepseek-v4-flash-0731)`);
  }
  const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(model)}/endpoints`;

  if (!modeQuiet) process.stderr.write(`${DIM}Fetching endpoints for ${slug}...${RESET}\n`);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  } catch (e) {
    throw new Error(`network error fetching ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GET ${slug}/endpoints failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`GET ${slug}/endpoints returned non-JSON body`);
  }

  // Structure validation with explicit failure messages.
  const root = body as { data?: unknown };
  if (!root.data || typeof root.data !== "object") {
    throw new Error(`GET ${slug}/endpoints response is missing .data (got ${typeof body})`);
  }
  const d = root.data as { endpoints?: unknown; id?: string; name?: string };
  if (!Array.isArray(d.endpoints)) {
    throw new Error(`GET ${slug}/endpoints response .data.endpoints is not an array (got ${typeof d.endpoints})`);
  }
  if (d.endpoints.length === 0) {
    throw new Error(
      `GET ${slug}/endpoints returned an empty endpoints array for ${d.id ?? slug} — model likely has no hosted endpoints`,
    );
  }

  const required = [
    "name",
    "provider_name",
    "quantization",
    "pricing",
    "throughput_last_30m",
    "latency_last_30m",
    "context_length",
    "status",
  ] as const;
  const epsAll = d.endpoints as OREndpoint[];
  for (const [i, e] of epsAll.entries()) {
    const missing = required.filter((k) => !(k in e));
    if (missing.length > 0) {
      throw new Error(`endpoint[${i}] (${e.name ?? "?"}) missing fields: ${missing.join(", ")}`);
    }
    if (
      typeof e.pricing !== "object" ||
      e.pricing === null ||
      typeof e.pricing.prompt !== "string" ||
      typeof e.pricing.completion !== "string"
    ) {
      throw new Error(`endpoint[${i}] (${e.name ?? "?"}) pricing.prompt/completion missing or not strings`);
    }
  }

  const fetched: EndpointFetch = { slug, id: d.id ?? slug, name: d.name ?? "", eps: epsAll };
  writeCache(cacheKey, fetched);
  return fetched;
}

interface EndpointRow {
  Provider: string;
  Quant: string;
  ZDR: string;
  Model: string;
  "$in/M": string;
  "$out/M": string;
  "$cr/M": string;
  "You/mo": string;
  "$cw/M": string;
  p50t: string;
  p90t: string;
  p50lat: string;
  up5m: string;
  ctx: string;
  status: string;
}

const ROW_COLS = [
  "Provider",
  "Quant",
  "ZDR",
  "Model",
  "$in/M",
  "$out/M",
  "$cr/M",
  "You/mo",
  "p50t",
  "p90t",
  "p50lat",
  "up5m",
  "ctx",
  "status",
];

/** Columns for a table whose endpoints may bill cache writes (rare). */
function rowCols(eps: OREndpoint[]): string[] {
  const cols = [...ROW_COLS];
  if (eps.some((e) => e.pricing.input_cache_write != null)) {
    cols.splice(cols.indexOf("$cr/M") + 1, 0, "$cw/M");
  }
  return cols;
}

function applyQuant(eps: OREndpoint[], slugForErr: string): OREndpoint[] {
  const q = parsed.values.quant.trim();
  const quantFilter = q ? q.split(",").map((s) => s.trim().toLowerCase()) : null;
  if (!quantFilter) return eps;
  const filtered = eps.filter((e) => e.quantization != null && quantFilter.includes(e.quantization.toLowerCase()));
  if (filtered.length === 0) {
    throw new Error(
      `--quant ${quantFilter.join(",")} matches no endpoints for ${slugForErr} (available: ${[...new Set(eps.map((e) => e.quantization ?? "unknown"))].sort().join(", ")})`,
    );
  }
  if (!modeQuiet) {
    process.stderr.write(
      `${DIM}Quant filter (${quantFilter.join(",")}): ${eps.length} → ${filtered.length} endpoints${RESET}\n`,
    );
  }
  return filtered;
}

const isZdrEndpoint =
  (zdrInfo: ZdrInfo) =>
  (e: OREndpoint): boolean =>
    (e.model_id != null && zdrInfo.zdr.has(`${e.model_id}|${e.tag}`)) || zdrInfo.tags.has(e.tag);

interface EndpointTierSet {
  inP: (v: number) => Tier;
  outP: (v: number) => Tier;
  crP: (v: number) => Tier;
  youP: (v: number) => Tier;
  t50: (v: number) => Tier;
  t90: (v: number) => Tier;
  lat: (v: number) => Tier;
  up: (v: number) => Tier;
  ctx: (v: number) => Tier;
}

/** Tercile heat for an endpoint rowset: cheaper/faster/longer-uptime = greener. */
function endpointTiers(eps: OREndpoint[], wl: SessionWorkload | null, scale: number): EndpointTierSet {
  return {
    inP: makeTiers(
      eps.map((e) => parsePrice(e.pricing.prompt)),
      true,
    ),
    outP: makeTiers(
      eps.map((e) => parsePrice(e.pricing.completion)),
      true,
    ),
    crP: makeTiers(
      eps.map((e) => optPrice(e.pricing.input_cache_read)),
      true,
    ),
    youP: makeTiers(
      eps.map((e) => youMoOf(e, wl, scale)),
      true,
    ),
    t50: makeTiers(eps.map((e) => e.throughput_last_30m?.p50 ?? NaN)),
    t90: makeTiers(eps.map((e) => e.throughput_last_30m?.p90 ?? NaN)),
    lat: makeTiers(
      eps.map((e) => e.latency_last_30m?.p50 ?? NaN),
      true,
    ),
    up: makeTiers(eps.map((e) => e.uptime_last_5m ?? NaN)),
    ctx: makeTiers(eps.map((e) => e.context_length)),
  };
}

function endpointRows(
  filtered: OREndpoint[],
  zdrInfo: ZdrInfo,
  modelShort: (e: OREndpoint) => string,
  tiers: EndpointTierSet,
  wl: SessionWorkload | null,
  scale: number,
): EndpointRow[] {
  const zdrKnown = zdrInfo.tags.size > 0;
  const isZdr = isZdrEndpoint(zdrInfo);
  return filtered
    .slice()
    .sort(
      (a, b) =>
        a.provider_name.localeCompare(b.provider_name) || parsePrice(a.pricing.prompt) - parsePrice(b.pricing.prompt),
    )
    .map((e) => {
      const pin = parsePrice(e.pricing.prompt);
      const pout = parsePrice(e.pricing.completion);
      const pcr = optPrice(e.pricing.input_cache_read);
      const pcw = optPrice(e.pricing.input_cache_write);
      const ymo = youMoOf(e, wl, scale);
      const t = e.throughput_last_30m;
      const l = e.latency_last_30m;
      const statusOk = e.status === 0;
      const zdr = isZdr(e);
      return {
        Provider: `${e.provider_name}${e.is_byok ? ` ${YELLOW}(BYOK)${RESET}` : ""}`,
        Quant: e.quantization ?? "-",
        ZDR: zdrKnown ? (zdr ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`) : "",
        Model: modelShort(e),
        "$in/M": Number.isNaN(pin) ? "(dyn)" : paint(fmtPrice(pin), tiers.inP(pin)),
        "$out/M": Number.isNaN(pout) ? "(dyn)" : paint(fmtPrice(pout), tiers.outP(pout)),
        "$cr/M": Number.isNaN(pcr) ? `${DIM}--${RESET}` : paint(fmtPrice(pcr), tiers.crP(pcr)),
        "You/mo": Number.isFinite(ymo) ? paint(fmtPrice(ymo), tiers.youP(ymo)) : "(dyn)",
        "$cw/M": Number.isNaN(pcw) ? `${DIM}--${RESET}` : fmtPrice(pcw),
        p50t: t?.p50 != null ? paint(t.p50.toFixed(0), tiers.t50(t.p50)) : "--",
        p90t: t?.p90 != null ? paint(t.p90.toFixed(0), tiers.t90(t.p90)) : "--",
        p50lat: l?.p50 != null ? paint(`${l.p50.toFixed(0)}ms`, tiers.lat(l.p50)) : "--",
        up5m: e.uptime_last_5m != null ? paint(`${e.uptime_last_5m.toFixed(1)}%`, tiers.up(e.uptime_last_5m)) : "--",
        ctx: paint(fmtCtx(e.context_length), tiers.ctx(e.context_length)),
        status: statusOk ? `${GREEN}ok${RESET}` : `${RED}${e.status}${RESET}`,
      };
    });
}

function routingHintLines(
  filtered: OREndpoint[],
  zdrInfo: ZdrInfo,
  wl: SessionWorkload | null,
  scale: number,
): string[] {
  const zdrKnown = zdrInfo.tags.size > 0;
  const isZdr = isZdrEndpoint(zdrInfo);
  const healthyBase = filtered.filter((e) => e.status === 0 && e.throughput_last_30m != null);
  const healthy = zdrKnown ? healthyBase.filter(isZdr) : healthyBase;
  const lines: string[] = [];
  if (healthyBase.length > 0 && zdrKnown && healthy.length === 0) {
    lines.push(
      `\n${YELLOW}Warning: no ZDR-compliant healthy endpoints with throughput stats — with zdr=true in pi.nix, none of these could actually be used.${RESET}`,
    );
  }
  if (healthy.length === 0) {
    if (lines.length > 0) return lines;
    return [`\n${YELLOW}No healthy endpoints with throughput stats — cannot suggest a routing floor.${RESET}`];
  }
  const cheap = [...healthy].sort((a, b) => parsePrice(a.pricing.prompt) - parsePrice(b.pricing.prompt))[0];
  const p50s = healthy
    .map((e) => e.throughput_last_30m?.p50)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const p90s = healthy
    .map((e) => e.throughput_last_30m?.p90)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  lines.push(`\n${BOLD}Routing hints${RESET}`);
  if (cheap?.throughput_last_30m) {
    lines.push(
      `  Cheapest healthy: ${CYAN}${cheap.provider_name}/${cheap.tag}${RESET} p50=${cheap.throughput_last_30m.p50?.toFixed(0)} p90=${cheap.throughput_last_30m.p90?.toFixed(0)} tok/s`,
    );
  }
  const byMix = healthy
    .map((e) => ({ e, c: youMoOf(e, wl, scale) }))
    .filter((x) => Number.isFinite(x.c))
    .sort((a, b) => a.c - b.c)[0];
  if (byMix && wl) {
    lines.push(
      `  Cheapest for your mix: ${CYAN}${byMix.e.provider_name}/${byMix.e.tag}${RESET} ~${fmtPrice(byMix.c)}/mo`,
    );
  }
  lines.push(
    `  Median across ${healthy.length} healthy: p50=${median(p50s).toFixed(0)}, p90=${median(p90s).toFixed(0)} tok/s`,
  );
  const floor = { p50: Math.round(median(p50s) * 0.8), p90: Math.round(median(p90s) * 0.8) };
  lines.push(`  Suggested preferred_min_throughput (80% of median): ${JSON.stringify(floor)}`);
  const demoted = healthy.filter(
    (e) =>
      (e.throughput_last_30m?.p90 != null && e.throughput_last_30m?.p90 < floor.p90) ||
      (e.throughput_last_30m?.p50 != null && e.throughput_last_30m?.p50 < floor.p50),
  );
  lines.push(
    demoted.length > 0
      ? `  Would demote: ${demoted.map((e) => e.provider_name).join(", ")}`
      : `  Nobody demoted at that floor — all healthy endpoints keep preferred status`,
  );
  return lines;
}

// ── Endpoints orchestration (single & cross-model) ──

function shortModelName(id: string): string {
  return (id.includes("/") ? id.split("/").pop() : id) ?? id;
}

async function endpoints(): Promise<void> {
  const slugs = [...new Set(modeEndpointSlugs)];
  const wl = loadSessionWorkload();
  const wlScale = wl ? WORKLOAD_WINDOW_MS / Math.max(wl.coverMs, 86_400_000) : 1;
  const key = getOpenRouterKey();
  const zdrInfo = await fetchZdrCatalog(key);

  // canonical_slug + embedded AA benchmarks come from the public models list.
  const canonBySlug = new Map<string, string>();
  const benchById = new Map<string, { coding?: number; intel?: number }>();
  try {
    for (const m of await fetchORModels()) {
      canonBySlug.set(m.id, m.canonical_slug ?? m.id);
      const aa = m.benchmarks?.artificial_analysis;
      if (aa) {
        benchById.set(m.id, { coding: aa.coding_index, intel: aa.intelligence_index });
      }
    }
  } catch {
    // public list unavailable → fall back to short slug for stats (may be zeros), no benchmarks
  }

  const results = await Promise.all(
    slugs.map(async (s) => {
      const r = await fetchModelEndpoints(s, key);
      r.eps = applyQuant(r.eps, s);
      return r;
    }),
  );

  if (results.length === 1) {
    const r = results[0];
    if (!r) return;
    const canon = canonBySlug.get(r.slug);

    if (modeJson) {
      console.log(
        JSON.stringify(
          {
            model: r.id,
            canonical_slug: canon ?? null,
            benchmarks: benchById.get(r.slug) ?? null,
            zdrKnown: zdrInfo.tags.size > 0 ? [...zdrInfo.tags].sort() : null,
            effective_pricing: await fetchEffPricing(canon ?? r.slug),
            endpoints: r.eps,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      `\n${BOLD}${r.id} — ${r.name}${RESET}  ${DIM}(${r.eps.length} endpoints, provider-sorted${parsed.values.quant.trim() ? `, quant=${parsed.values.quant.trim()}` : ""})${RESET}`,
    );
    console.log(
      Bun.inspect.table(
        endpointRows(r.eps, zdrInfo, () => "", endpointTiers(r.eps, wl, wlScale), wl, wlScale),
        rowCols(r.eps).filter((c) => c !== "Model"),
      ),
    );

    if (wl) {
      const ym = r.eps
        .map((e) => ({ e, c: youMoOf(e, wl, wlScale) }))
        .filter((x) => Number.isFinite(x.c))
        .sort((a, b) => a.c - b.c);
      if (ym.length > 0) {
        const med = ym[Math.floor(ym.length / 2)]?.c ?? NaN;
        const worst = ym[ym.length - 1]?.c ?? NaN;
        const rec = wl.byModel.get(r.id)?.cost ?? 0;
        console.log(
          `  Your mix on these endpoints: best ${fmtPrice(ym[0]?.c ?? NaN)}/mo (${ym[0]?.e.provider_name}) · median ${fmtPrice(med)}/mo · worst ${fmtPrice(worst)}/mo · recorded on this model: $${(rec * wlScale).toFixed(2)}/mo${RESET}`,
        );
      }
    }
    for (const l of effLines(await fetchEffPricing(canon ?? r.slug))) console.log(l);
    const b = benchById.get(r.slug);
    if (b?.coding != null || b?.intel != null) {
      const parts = [
        b.coding != null ? `coding=${b.coding}` : null,
        b.intel != null ? `intel=${b.intel}` : null,
      ].filter(Boolean);
      console.log(`  Benchmarks (OpenRouter-embedded): ${parts.join(" ")}`);
    }
    for (const l of routingHintLines(r.eps, zdrInfo, wl, wlScale)) console.log(l);
    return;
  }

  // ── Cross-model comparison (≥2 slugs) ──

  const agg = await Promise.all(
    results.map(async (r) => {
      const routable = pickRoutable(r.eps, zdrInfo);
      const canon = canonBySlug.get(r.slug);
      return {
        r,
        routable,
        stIn: priceStats(routable.map((e) => parsePrice(e.pricing.prompt))),
        stOut: priceStats(routable.map((e) => parsePrice(e.pricing.completion))),
        stCr: priceStats(routable.map((e) => optPrice(e.pricing.input_cache_read))),
        youMed: median(routable.map((e) => youMoOf(e, wl, wlScale)).filter((v) => Number.isFinite(v))),
        p50med: median(routable.map((e) => e.throughput_last_30m?.p50).filter((v): v is number => v != null)),
        eff: await fetchEffPricing(canon ?? r.slug),
        bench: benchById.get(r.slug),
      };
    }),
  );

  if (modeJson) {
    console.log(
      JSON.stringify(
        {
          range: RANGE_LABELS[modeRange] ?? (modeRange || "today"),
          models: results.map((r) => ({ id: r.id, slug: r.slug, name: r.name, endpoints: r.eps })),
          comparison: {
            per_model: agg.map((a) => ({
              slug: a.r.slug,
              routable_endpoints: a.routable.length,
              listed_input: a.stIn,
              listed_output: a.stOut,
              listed_cache_read: a.stCr,
              your_mix_monthly: Number.isFinite(a.youMed) ? { median: a.youMed } : null,
              median_p50_throughput: Number.isNaN(a.p50med) ? null : a.p50med,
              effective: a.eff,
              benchmarks: a.bench ?? null,
            })),
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `\n${BOLD}${results.map((r) => r.slug).join(" vs ")}${RESET}  ${DIM}(${agg.reduce((n, a) => n + a.routable.length, 0)} routable endpoints, provider-sorted${parsed.values.quant.trim() ? `, quant=${parsed.values.quant.trim()}` : ""})${RESET}`,
  );

  // Merged view. Same-provider rows land adjacent, so one provider's pricing of
  // both models is directly comparable down a column.
  const allEps = results.flatMap((r) => r.eps);
  console.log(
    Bun.inspect.table(
      endpointRows(
        allEps,
        zdrInfo,
        (e) => shortModelName(e.model_id ?? e.name),
        endpointTiers(allEps, wl, wlScale),
        wl,
        wlScale,
      ),
      rowCols(allEps),
    ),
  );

  console.log(
    `\n${BOLD}Per model${RESET}  ${DIM}(listed over routable non-dynamic endpoints · eff = traffic-weighted ${RANGE_LABELS[modeRange] ?? (modeRange || "today")}; eff in nets fleet cache hits, Cr med is listed cache-read)${RESET}`,
  );
  const aggTiers = {
    medIn: makeTiers(
      agg.map((a) => a.stIn?.med ?? NaN),
      true,
    ),
    avgIn: makeTiers(
      agg.map((a) => a.stIn?.avg ?? NaN),
      true,
    ),
    medOut: makeTiers(
      agg.map((a) => a.stOut?.med ?? NaN),
      true,
    ),
    medCr: makeTiers(
      agg.map((a) => a.stCr?.med ?? NaN),
      true,
    ),
    youMed: makeTiers(
      agg.map((a) => a.youMed),
      true,
    ),
    effIn: makeTiers(
      agg.map((a) => a.eff?.weightedInputPrice ?? NaN),
      true,
    ),
    cache: makeTiers(agg.map((a) => a.eff?.weightedCacheHitRate ?? NaN)),
    vol: makeTiers(agg.map((a) => (a.eff ? a.eff.providerSummaries.reduce((t, p) => t + p.totalTokens, 0) : NaN))),
    p50: makeTiers(agg.map((a) => a.p50med)),
    coding: makeTiers(agg.map((a) => a.bench?.coding ?? NaN)),
    intel: makeTiers(agg.map((a) => a.bench?.intel ?? NaN)),
  };
  const cell = (s: ReturnType<typeof priceStats>, f: (x: number) => string, tier: (v: number) => Tier): string =>
    s ? paint(f(s.med), tier(s.med)) : `${DIM}--${RESET}`;
  console.log(
    Bun.inspect.table(
      agg.map((a) => {
        const wIn = a.eff?.weightedInputPrice;
        const wCache = a.eff?.weightedCacheHitRate;
        const vol = a.eff ? a.eff.providerSummaries.reduce((t, p) => t + p.totalTokens, 0) : NaN;
        return {
          Model: shortModelName(a.r.id),
          N: a.routable.length,
          "In med": cell(a.stIn, fmtPrice, aggTiers.medIn),
          "In avg": a.stIn ? paint(fmtPrice(a.stIn.avg), aggTiers.avgIn(a.stIn.avg)) : `${DIM}--${RESET}`,
          "Out med": cell(a.stOut, fmtPrice, aggTiers.medOut),
          "Cr med": cell(a.stCr, fmtPrice, aggTiers.medCr),
          "You med": Number.isFinite(a.youMed)
            ? paint(fmtPrice(a.youMed), aggTiers.youMed(a.youMed))
            : `${DIM}--${RESET}`,
          "Eff in": wIn != null ? paint(fmtPrice(wIn), aggTiers.effIn(wIn)) : `${DIM}--${RESET}`,
          "Cache%": wCache != null ? paint(`${(wCache * 100).toFixed(0)}%`, aggTiers.cache(wCache)) : "--",
          Vol: Number.isFinite(vol) ? paint(humanTokens(vol), aggTiers.vol(vol)) : "--",
          p50t: Number.isNaN(a.p50med) ? `${DIM}--${RESET}` : paint(a.p50med.toFixed(0), aggTiers.p50(a.p50med)),
          Coding:
            a.bench?.coding != null
              ? paint(a.bench.coding.toFixed(1).padStart(5), aggTiers.coding(a.bench.coding))
              : `${DIM}${"".padStart(5)}${RESET}`,
          Intel:
            a.bench?.intel != null
              ? paint(a.bench.intel.toFixed(1).padStart(5), aggTiers.intel(a.bench.intel))
              : `${DIM}${"".padStart(5)}${RESET}`,
        };
      }),
      [
        "Model",
        "N",
        "In med",
        "In avg",
        "Out med",
        "Cr med",
        "You med",
        "Eff in",
        "Cache%",
        "Vol",
        "p50t",
        "Coding",
        "Intel",
      ],
    ),
  );

  const pooledIn = priceStats(agg.flatMap((a) => a.routable.map((e) => parsePrice(e.pricing.prompt))));
  const pricedN = agg.reduce(
    (n, a) => n + a.routable.filter((e) => Number.isFinite(parsePrice(e.pricing.prompt))).length,
    0,
  );
  const dynN = agg.reduce((n, a) => n + a.routable.length, 0) - pricedN;
  console.log(
    `  Pooled listed in-price: ${pooledIn ? `med ${fmtPrice(pooledIn.med)}, avg ${fmtPrice(pooledIn.avg)} (${pricedN} endpoints)` : "no priced endpoints"}${dynN > 0 ? ` · ${dynN} free/dynamic excluded` : ""}`,
  );

  // Value: benchmark points per median listed input-dollar (OR-embedded coding index).
  const valued = agg
    .flatMap((a) => {
      if (a.bench?.coding == null || !a.stIn) return [];
      return [{ slug: a.r.slug, coding: a.bench.coding, medIn: a.stIn.med }];
    })
    .map((v) => ({ ...v, ratio: v.medIn > 0 ? v.coding / v.medIn : Infinity }))
    .sort((a, b) => b.ratio - a.ratio);
  if (valued.length >= 2) {
    console.log(`\n${BOLD}Value (coding pts ÷ median listed-in)${RESET}`);
    for (const v of valued) {
      const ratio = v.ratio === Infinity ? "free" : `${v.ratio.toFixed(0)} pts/$`;
      console.log(
        `  ${CYAN}${shortModelName(v.slug)}${RESET}  coding=${v.coding.toFixed(1)}  med-in ${fmtPrice(v.medIn)}  → ${ratio}`,
      );
    }
  }
}

async function local(): Promise<void> {
  const omlxBase = "http://127.0.0.1:8124/admin/api";

  // Check oMLX is running
  try {
    await fetch(`${omlxBase.replace("/admin/api", "")}/health`);
  } catch {
    console.error(`${RED}oMLX not running at localhost:8124${RESET}`);
    process.exit(1);
  }

  // Get current loaded models
  const modelsRes = await fetch(`${omlxBase}/models`);
  const modelsData = await (modelsRes.json() as Promise<{
    models: Array<{
      id: string;
      loaded: boolean;
      estimated_size: number;
      estimated_size_formatted: string;
      pinned: boolean;
    }>;
  }>);
  const currentModels = modelsData.models;

  // Get trending MLX models
  if (!modeQuiet) process.stderr.write(`${DIM}Fetching trending MLX models from oMLX...${RESET}\n`);
  const trendingRes = await fetch(`${omlxBase}/hf/recommended?mlx_only=true`);
  const trendingData = await (trendingRes.json() as Promise<{
    trending: Array<{
      repo_id: string;
      name: string;
      downloads: number;
      likes: number;
      trending_score: number;
      size_formatted: string;
      size: number;
      params_formatted: string;
    }>;
  }>);
  const trending = trendingData.trending ?? [];

  if (modeJson) {
    console.log(JSON.stringify({ currentModels, trending }, null, 2));
    return;
  }

  // RAM budget
  const totalRAM = getSystemRAMGB();
  const available = totalRAM - SYSTEM_OVERHEAD_GB;

  console.log(
    `\n${BOLD}RAM Budget: ${totalRAM} GB${RESET}  ${DIM}(system ~${SYSTEM_OVERHEAD_GB} GB, inference ~${available} GB)${RESET}`,
  );

  // Show current models
  console.log(`\n${BOLD}Current oMLX models${RESET}`);
  console.log(
    Bun.inspect.table(
      currentModels.map((m) => {
        const est = estimateModel(m.estimated_size, m.id, totalRAM);
        return {
          Model: m.id,
          Size: m.estimated_size_formatted,
          Status: `${m.loaded ? `${GREEN}loaded${RESET}` : `${DIM}idle${RESET}`}${m.pinned ? ` ${YELLOW}pin${RESET}` : ""}`,
          "tok/s": fmtEstTokPerSec(est),
          Headroom: `${est.headroomGB > 0 ? est.headroomGB : `${RED}${est.headroomGB}${RESET}`} GB`,
          Fit: fmtComfort(est.comfort),
        };
      }),
      ["Model", "Size", "Status", "tok/s", "Headroom", "Fit"],
    ),
  );

  // Show trending
  const alreadyDownloaded = new Set(currentModels.map((m) => m.id));

  console.log(`\n${BOLD}Trending MLX models${RESET}  ${DIM}(top 20, estimates for ${totalRAM} GB)${RESET}`);
  console.log(
    Bun.inspect.table(
      trending.slice(0, 20).map((m) => {
        const est = estimateModel(m.size, m.repo_id, totalRAM);
        const dl = m.downloads > 1000 ? `${(m.downloads / 1000).toFixed(1)}K` : String(m.downloads);
        const has = alreadyDownloaded.has(m.repo_id) ? ` ${GREEN}✓${RESET}` : "";
        return {
          Repo: m.repo_id,
          Size: m.size_formatted,
          Type: est.type === "moe" ? `${YELLOW}MoE${RESET}` : `dense`,
          "tok/s": fmtEstTokPerSec(est),
          Headroom: `${est.headroomGB > 0 ? est.headroomGB : `${RED}${est.headroomGB}${RESET}`} GB`,
          Fit: fmtComfort(est.comfort),
          DL: dl + has,
        };
      }),
      ["Repo", "Size", "Type", "tok/s", "Headroom", "Fit", "DL"],
    ),
  );

  // ── Recommended picks (quality-ranked) ──
  // Use AA benchmarks + OR open-weight data to rank models by quality.
  // Supplement trending with HF searches for known open-weight families.
  const isNotJunk = (repo: string) => !/tts|asr|voice|speech|privacy.?filter|embed|rerank/i.test(repo);
  const seriousFromTrending = trending
    .filter((m) => m.size >= 5_000_000_000 && isNotJunk(m.repo_id))
    .map((m) => ({ ...m, est: estimateModel(m.size, m.repo_id, totalRAM) }))
    .filter((m) => m.est.headroomGB >= 10 && m.est.comfort !== "overflow");

  // Load OR and AA data early for family discovery and benchmark matching
  let orModels: ORModel[] = [];
  try {
    orModels = await fetchORModels();
  } catch {
    // OR not available
  }
  let aaModels: AAModel[] = [];
  try {
    const aaKey = getAAKey();
    aaModels = await fetchAAModels(aaKey);
  } catch {
    // AA not available
  }
  const aaLookup = buildAALookup(aaModels);
  const orHfToId = new Map<string, string>();
  for (const m of orModels) {
    if (m.hugging_face_id) {
      orHfToId.set(m.hugging_face_id.toLowerCase(), m.id);
    }
  }

  // Candidate pool is built after deduplication (below)

  // Search HF for open-weight model families (derived from OR models with HF IDs)
  // Extract unique model family names from HuggingFace IDs, deduplicate by org/name.
  const seenFamilies = new Set<string>();
  const searchFamilies: string[] = [];
  for (const m of orModels) {
    if (!m.hugging_face_id) continue;
    const hfName = m.hugging_face_id.split("/").pop() ?? "";
    const base = hfName.replace(/-(instruct|it|chat|base|v\d+|\d+b|a\d+b|fp\d+|bf\d+|gptq|awq|mlx).*$/i, "");
    if (base && !seenFamilies.has(base.toLowerCase())) {
      seenFamilies.add(base.toLowerCase());
      searchFamilies.push(base);
    }
  }

  if (!modeQuiet) {
    const cachedCount = searchFamilies.filter((f) => readCache(`hf-search-${f.toLowerCase()}`)).length;
    const freshCount = searchFamilies.length - cachedCount;
    process.stderr.write(
      `${DIM}Searching HF for ${searchFamilies.length} families (${cachedCount} cached, ${freshCount} fresh)...${RESET}\n`,
    );
  }
  const searchPromises = searchFamilies.map(async (family) => {
    const cacheKey = `hf-search-${family.toLowerCase()}`;
    const cached = readCache<{
      models: Array<{
        repo_id: string;
        size: number;
        size_formatted: string;
        downloads: number;
        likes: number;
        trending_score: number;
        params_formatted: string;
      }>;
    }>(cacheKey);
    if (cached) return cached.models;
    try {
      const res = await fetch(
        `${omlxBase}/hf/search?q=${encodeURIComponent(family)}&sort=downloads&limit=20&mlx_only=true`,
      );
      const data = (await res.json()) as {
        models: Array<{
          repo_id: string;
          size: number;
          size_formatted: string;
          downloads: number;
          likes: number;
          trending_score: number;
          params_formatted: string;
        }>;
      };
      const models = data.models ?? [];
      writeCache(cacheKey, { models });
      return models;
    } catch {
      return [];
    }
  });
  const searchResults = await Promise.all(searchPromises);
  // Deduplicate by model identity: extract base model name ignoring org, quant, and variant tags.
  const familyBest = new Map<
    string,
    {
      repo_id: string;
      size: number;
      size_formatted: string;
      downloads: number;
      est: ModelEstimate;
    }
  >();

  // Extract a canonical model identity key from a repo ID.
  // Strip org, quant suffixes, variant tags, and format indicators.
  // e.g. "mlx-community/Qwen3.6-27B-4bit" -> "qwen3.6-27b"
  //      "OrchardPair/Qwen3.6-27B-OptiQ-4bit" -> "qwen3.6-27b"
  //      "dealignai/Gemma-4-31B-JANG_4M-CRACK" -> "gemma-4-31b-jang_4m-crack" (fine-tune identity preserved)
  const modelIdentity = (repo: string): string => {
    // Drop org prefix
    const name = (repo.includes("/") ? repo.split("/").pop() : repo) ?? repo;
    return (
      name
        // Strip quant/format suffixes
        .replace(
          /[-_.](4bit|8bit|6bit|5bit|4\.5bit|3bit|2bit|2\.6bit|nvfp4|mxfp4|mxfp8|bf16|fp16|fp32|q[2-8](_[a-z]+)?|ud-mlx|ud-q[68]_xl|mlx-tuned|oq\d?|dwq|qat)$/i,
          "",
        )
        .replace(/[-_.](mlx|mixed_\d+_\d+|mlx-\d+bit)$/i, "")
        // Strip trailing quant indicators embedded in name
        .replace(/[-_](\d+)\s*(bit|b\s*$)/i, "")
        .toLowerCase()
    );
  };

  const addIfBest = (
    m: { repo_id: string; size: number; size_formatted: string; downloads: number },
    est: ModelEstimate,
  ) => {
    if (m.size < 1_000_000_000 || !isNotJunk(m.repo_id)) return;
    if (est.headroomGB < 10 || est.comfort === "overflow") return;
    const key = modelIdentity(m.repo_id);
    const existing = familyBest.get(key);
    const alreadyHas = alreadyDownloaded.has(m.repo_id);
    const existingAlreadyHas = existing ? alreadyDownloaded.has(existing.repo_id) : false;
    if (
      !existing ||
      (alreadyHas && !existingAlreadyHas) ||
      (alreadyHas === existingAlreadyHas && m.downloads > existing.downloads)
    ) {
      familyBest.set(key, {
        repo_id: m.repo_id,
        size: m.size,
        size_formatted: m.size_formatted,
        downloads: m.downloads,
        est,
      });
    }
  };

  for (const m of seriousFromTrending) {
    addIfBest(m, m.est);
  }
  for (const models of searchResults) {
    for (const m of models) {
      if (!m.repo_id) continue;
      const est = estimateModel(m.size, m.repo_id, totalRAM);
      addIfBest(m, est);
    }
  }

  // Build final candidate list from deduplicated family bests
  const candidateRepos = new Map([...familyBest.entries()].map(([, v]) => [v.repo_id, v]));

  // Match each candidate to AA benchmarks
  interface RankedModel {
    repo_id: string;
    size: number;
    size_formatted: string;
    downloads: number;
    est: ModelEstimate;
    aaCoding: number | null;
    aaIntel: number | null;
    aaQualityScore: number;
  }

  const ranked: RankedModel[] = [];
  for (const m of candidateRepos.values()) {
    let aaCoding: number | null = null;
    let aaIntel: number | null = null;

    // Try matching repo -> OR (via HF ID) -> AA
    const repoLower = m.repo_id.toLowerCase();
    for (const [hfId, orId] of orHfToId) {
      const hfName = hfId.split("/").pop() ?? "";
      if (repoLower.includes(hfName.replace(/-/g, "")) || repoLower.includes(hfName)) {
        const orModel = orModels.find((o) => o.id === orId);
        if (orModel) {
          const aa = joinORWithAA(orModel, aaLookup);
          if (aa?.evaluations) {
            aaCoding = aa.evaluations.artificial_analysis_coding_index ?? null;
            aaIntel = aa.evaluations.artificial_analysis_intelligence_index ?? null;
          }
        }
        break;
      }
    }

    // Fallback: direct slug match from AA
    if (aaCoding === null) {
      for (const [, aa] of aaLookup) {
        const aaSlug = aa.slug.toLowerCase();
        const repoFamily = repoLower.split("/").pop()?.split("-").slice(0, 3).join("-") ?? "";
        if (aaSlug.includes(repoFamily) || repoLower.includes(aaSlug)) {
          aaCoding = aa.evaluations?.artificial_analysis_coding_index ?? null;
          aaIntel = aa.evaluations?.artificial_analysis_intelligence_index ?? null;
          break;
        }
      }
    }

    // Quality score: AA coding index if available, else heuristic from size
    let aaQualityScore: number;
    if (aaCoding !== null) {
      aaQualityScore = aaCoding;
    } else if (m.est.type === "moe") {
      aaQualityScore = 20;
    } else {
      const sizeGB = m.size / 1e9;
      if (sizeGB > 20) aaQualityScore = 30;
      else if (sizeGB > 14) aaQualityScore = 25;
      else if (sizeGB > 8) aaQualityScore = 18;
      else aaQualityScore = 10;
    }

    ranked.push({
      repo_id: m.repo_id,
      size: m.size,
      size_formatted: m.size_formatted,
      downloads: m.downloads,
      est: m.est,
      aaCoding,
      aaIntel,
      aaQualityScore,
    });
  }

  // Separate dense and MoE, sort by quality score
  const dense = ranked.filter((m) => m.est.type === "dense").sort((a, b) => b.aaQualityScore - a.aaQualityScore);
  const moe = ranked.filter((m) => m.est.type === "moe").sort((a, b) => b.aaQualityScore - a.aaQualityScore);

  const fmtRanked = (m: RankedModel) => {
    const has = alreadyDownloaded.has(m.repo_id) ? ` ${GREEN}(yours)${RESET}` : "";
    const coding =
      m.aaCoding != null ? fmtScore(m.aaCoding, 5) : `${DIM}~${m.aaQualityScore.toFixed(0).padStart(4)}${RESET}`;
    return {
      Repo: m.repo_id + has,
      Size: m.size_formatted,
      Coding: coding,
      "tok/s": fmtEstTokPerSec(m.est),
      Headroom: `${m.est.headroomGB} GB`,
      DL: m.downloads > 1000 ? `${(m.downloads / 1000).toFixed(1)}K` : String(m.downloads),
    };
  };

  const MAX_ROWS = verbose ? 100 : 25;

  if (dense.length > 0) {
    const rows = dense.slice(0, MAX_ROWS);
    console.log(
      `\n${BOLD}Dense (quality)${RESET}  ${DIM}(all params active, sorted by coding benchmark, top ${rows.length})${RESET}`,
    );
    console.log(Bun.inspect.table(rows.map(fmtRanked), ["Repo", "Size", "Coding", "tok/s", "Headroom", "DL"]));
  }

  if (moe.length > 0) {
    const rows = moe.slice(0, MAX_ROWS);
    console.log(
      `\n${BOLD}MoE (speed)${RESET}  ${DIM}(sparse active params, sorted by coding benchmark, top ${rows.length})${RESET}`,
    );
    console.log(Bun.inspect.table(rows.map(fmtRanked), ["Repo", "Size", "Coding", "tok/s", "Headroom", "DL"]));
  }
}

// ── Model query mode ──

interface ModelQueryResult {
  repo_id: string;
  found: boolean;
  size?: number;
  size_formatted?: string;
  params?: number;
  params_formatted?: string;
  downloads?: number;
  est?: ModelEstimate;
  aaCoding?: number | null;
  aaIntel?: number | null;
  error?: string;
}

async function modelQuery(): Promise<void> {
  const omlxBase = "http://127.0.0.1:8124/admin/api";

  // Check oMLX is running
  try {
    await fetch(`${omlxBase.replace("/admin/api", "")}/health`);
  } catch {
    console.error(`${RED}oMLX not running at localhost:8124${RESET}`);
    process.exit(1);
  }

  if (modeModels.length === 0) {
    console.error(`${RED}No models specified. Use --model <repo_id> (repeatable).${RESET}`);
    process.exit(1);
  }

  const totalRAM = getSystemRAMGB();
  const results: ModelQueryResult[] = [];

  // Fetch AA data for benchmark matching (once)
  let aaModels: AAModel[] = [];
  let aaLookup = buildAALookup(aaModels);
  const orHfToId = new Map<string, string>();
  let orModels: ORModel[] = [];
  try {
    const aaKey = getAAKey();
    aaModels = await fetchAAModels(aaKey);
    aaLookup = buildAALookup(aaModels);
    orModels = await fetchORModels();
    for (const m of orModels) {
      if (m.hugging_face_id) {
        orHfToId.set(m.hugging_face_id.toLowerCase(), m.id);
      }
    }
  } catch {
    // AA/OR unavailable — will show no benchmarks
  }

  // Fetch model info for each repo
  const fetchPromises = modeModels.map(async (repo) => {
    const result: ModelQueryResult = { repo_id: repo, found: false };
    try {
      const res = await fetch(`${omlxBase}/hf/model-info?repo_id=${encodeURIComponent(repo)}`);
      const data = (await res.json()) as {
        repo_id: string;
        size: number;
        size_formatted: string;
        params: number;
        params_formatted: string;
        downloads: number;
      };
      if (res.ok && data.repo_id) {
        result.found = true;
        result.size = data.size;
        result.size_formatted = data.size_formatted;
        result.params = data.params;
        result.params_formatted = data.params_formatted;
        result.downloads = data.downloads;
        result.est = estimateModel(data.size, data.repo_id, totalRAM);

        // Try to match AA benchmarks
        const repoLower = data.repo_id.toLowerCase();
        for (const [hfId, orId] of orHfToId) {
          const hfName = hfId.split("/").pop() ?? "";
          if (repoLower.includes(hfName.replace(/-/g, "")) || repoLower.includes(hfName)) {
            const orModel = orModels.find((o) => o.id === orId);
            if (orModel) {
              const aa = joinORWithAA(orModel, aaLookup);
              if (aa?.evaluations) {
                result.aaCoding = aa.evaluations.artificial_analysis_coding_index ?? null;
                result.aaIntel = aa.evaluations.artificial_analysis_intelligence_index ?? null;
              }
            }
            break;
          }
        }
        // Fallback: direct slug match
        if (result.aaCoding == null) {
          for (const [, aa] of aaLookup) {
            const aaSlug = aa.slug.toLowerCase();
            const repoFamily = repoLower.split("/").pop()?.split("-").slice(0, 3).join("-") ?? "";
            if (aaSlug.includes(repoFamily) || repoLower.includes(aaSlug)) {
              result.aaCoding = aa.evaluations?.artificial_analysis_coding_index ?? null;
              result.aaIntel = aa.evaluations?.artificial_analysis_intelligence_index ?? null;
              break;
            }
          }
        }
      } else {
        result.error = (data as { detail?: string }).detail || "Model not found";
      }
    } catch (e) {
      result.error = e instanceof Error ? e.message : "Unknown error";
    }
    return result;
  });

  const resolved = await Promise.all(fetchPromises);
  results.push(...resolved);

  if (modeJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  // Unified row type
  type TableRow = {
    Model: string;
    Size: string;
    Params: string;
    "tok/s": string;
    Headroom: string;
    Fit: string;
    Coding: string;
    DL: string;
  };

  const allRows: TableRow[] = results.map((r): TableRow => {
    if (!r.found) {
      return {
        Model: `${RED}${r.repo_id}${RESET} (not found)`,
        Size: "--",
        Params: "--",
        "tok/s": "--",
        Headroom: "--",
        Fit: "--",
        Coding: "--",
        DL: "--",
      };
    }
    if (!r.est || !r.size_formatted || !r.params_formatted) {
      return {
        Model: r.repo_id,
        Size: "--",
        Params: "--",
        "tok/s": "--",
        Headroom: "--",
        Fit: "--",
        Coding: "--",
        DL: "--",
      };
    }
    const est = r.est;
    const coding = r.aaCoding != null ? fmtScore(r.aaCoding) : `${DIM}--${RESET}`;
    return {
      Model: r.repo_id,
      Size: r.size_formatted,
      Params: r.params_formatted,
      "tok/s": fmtEstTokPerSec(est),
      Headroom: `${est.headroomGB > 0 ? est.headroomGB : `${RED}${est.headroomGB}${RESET}`} GB`,
      Fit: fmtComfort(est.comfort),
      Coding: coding,
      DL:
        r.downloads != null ? (r.downloads > 1000 ? `${(r.downloads / 1000).toFixed(1)}K` : String(r.downloads)) : "--",
    };
  });

  console.log(`\n${BOLD}Model estimates for ${totalRAM} GB system${RESET}  ${DIM}(${results.length} models)${RESET}`);
  const cols = allRows[0] ? Object.keys(allRows[0]) : [];
  console.log(Bun.inspect.table(allRows, cols));

  // Summary: highlight problems
  const problems = results.filter(
    (r): r is ModelQueryResult & { est: ModelEstimate } => !r.found || (r.est != null && r.est.comfort === "overflow"),
  );
  if (problems.length > 0) {
    console.log(`\n${RED}Issues:${RESET}`);
    for (const r of problems) {
      if (!r.found) {
        console.log(`  ${RED}${r.repo_id}${RESET}: ${r.error}`);
      } else if (r.est?.comfort === "overflow") {
        console.log(`  ${RED}${r.repo_id}${RESET}: exceeds RAM (${r.size_formatted} on ${totalRAM} GB system)`);
      }
    }
  }

  // Highlight comfortable fits
  const comfortable = results.filter(
    (r): r is ModelQueryResult & { est: ModelEstimate } => r.found && r.est != null && r.est.comfort === "comfortable",
  );
  if (comfortable.length > 0) {
    console.log(`\n${GREEN}Comfortable fits (${comfortable.length}):${RESET}`);
    for (const r of comfortable) {
      console.log(`  ${CYAN}${r.repo_id}${RESET} (${r.size_formatted}, ~${r.est.tokPerSec} tok/s)`);
    }
  }
}

// ── Main ──

async function main(): Promise<void> {
  if (modeDrift) {
    await drift();
  } else if (modeEndpointSlugs.length > 0) {
    await endpoints();
  } else if (modeModels.length > 0) {
    await modelQuery();
  } else if (modeLocal) {
    await local();
  } else {
    await discover();
  }
}

main().catch((e) => {
  console.error(`${RED}Error: ${e.message}${RESET}`);
  process.exit(1);
});
