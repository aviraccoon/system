/**
 * OpenRouter catalog access shared by `scripts/model-scan.ts` and the or-pin
 * extension: endpoint shapes, the ZDR-eligibility rule, and a file cache under
 * `~/.cache/model-scan`.
 *
 * The ZDR rule lives here so the scan's ZDR column and a pin decision cannot
 * disagree about which endpoints a request may reach — an endpoint is eligible
 * when its `(model_id, tag)` pair is in `/api/v1/endpoints/zdr`, or when its
 * bare `tag` is (some rows arrive without a `model_id`).
 *
 * Node APIs only: the scan runs under Bun and the extension under Node, and
 * only the intersection is safe.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OREndpoint {
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

export interface ZdrCatalog {
  byModel: Map<string, OREndpoint[]>;
  zdr: Set<string>; // model_id|tag
  tags: Set<string>; // tag-only fallback
}

export interface EndpointFetch {
  slug: string;
  id: string;
  name: string;
  eps: OREndpoint[];
}

/** Progress and degradation reports, so the caller owns colors and `-q`. */
export interface OrCatalogLog {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * Cache directory. `OR_CATALOG_CACHE_DIR` overrides it so a comparison or a
 * test can point both consumers at one frozen snapshot; it is read per call so
 * an importer's load order cannot decide it.
 */
export function cacheDir(): string {
  return process.env.OR_CATALOG_CACHE_DIR ?? join(homedir(), ".cache", "model-scan");
}

export const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours
export const ENDPOINT_CACHE_TTL = 1000 * 60 * 15; // 15 min — endpoint perf/availability drifts fast

export function readCache<T>(name: string, ttlMs = CACHE_TTL): T | null {
  const p = join(cacheDir(), `${name}.json`);
  if (!existsSync(p)) return null;
  try {
    const s = statSync(p);
    if (Date.now() - s.mtimeMs > ttlMs) return null;
    return JSON.parse(readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Age of a cache entry in milliseconds, or undefined when it is absent or
 * unreadable. Lets a caller say why the cached copy is not being used. Clamped
 * at zero: a file's mtime can sit a fraction of a millisecond ahead of
 * `Date.now()`, and a negative age would render as "-0 min old". */
export function cacheAgeMs(name: string): number | undefined {
  const p = join(cacheDir(), `${name}.json`);
  if (!existsSync(p)) return undefined;
  try {
    return Math.max(0, Date.now() - statSync(p).mtimeMs);
  } catch {
    return undefined;
  }
}

export function writeCache(name: string, data: unknown): void {
  mkdirSync(cacheDir(), { recursive: true });
  writeFileSync(join(cacheDir(), `${name}.json`), JSON.stringify(data));
}

/** Catalog row shape: a non-null object with a tag and a prompt price. */
export function catalogRowOk(row: unknown): boolean {
  const e = row as { pricing?: { prompt?: unknown }; tag?: unknown } | null | undefined;
  return e != null && typeof e.pricing?.prompt === "string" && typeof e.tag === "string";
}

/** Non-empty array of well-formed catalog rows (cached or fetched). */
export function isZdrPayload(rows: unknown): rows is OREndpoint[] {
  return Array.isArray(rows) && rows.length > 0 && rows.every(catalogRowOk);
}

/** Index the catalog for ZDR checks: (model_id, tag) pairs with a tag-only
 * fallback, plus endpoints grouped by model. */
export function buildZdrCatalog(endpoints: OREndpoint[]): ZdrCatalog {
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

export function isZdrEndpoint(zdrInfo: ZdrCatalog, e: OREndpoint): boolean {
  return (e.model_id != null && zdrInfo.zdr.has(`${e.model_id}|${e.tag}`)) || zdrInfo.tags.has(e.tag);
}

/** Routable-for-us endpoints: up, and ZDR-compliant when the ZDR list loaded. */
export function pickRoutable(eps: OREndpoint[], zdrInfo: ZdrCatalog): OREndpoint[] {
  const zdrKnown = zdrInfo.tags.size > 0;
  return eps.filter((e) => e.status === 0 && (!zdrKnown || isZdrEndpoint(zdrInfo, e)));
}

/** ZDR is provider-level: each endpoint's provider data policy decides whether
 * prompts are retained. `/endpoints/zdr` returns every endpoint that survives
 * ZDR enforcement, pricing and live status included. It needs a credential;
 * without one this serves the cached copy and degrades to an empty catalog.
 * `fresh` skips the cached copy and refetches. */
export async function fetchZdrCatalog(opts: { key?: string; log: OrCatalogLog; fresh?: boolean }): Promise<ZdrCatalog> {
  const { key, log, fresh } = opts;
  const empty = (): ZdrCatalog => buildZdrCatalog([]);
  const cached = fresh ? null : readCache<{ endpoints?: OREndpoint[] }>("or-zdr-endpoints", ENDPOINT_CACHE_TTL);
  const cachedEndpoints = cached?.endpoints;
  if (isZdrPayload(cachedEndpoints)) {
    log.info("Using cached ZDR endpoint catalog");
    return buildZdrCatalog(cachedEndpoints);
  }
  if (!key) {
    const age = cacheAgeMs("or-zdr-endpoints");
    const why = age === undefined ? "no cached copy" : `cached copy is ${Math.round(age / 60_000)} min old`;
    log.warn(`Warning: no OpenRouter credential for /endpoints/zdr — ${why}. ZDR data omitted.`);
    return empty();
  }
  log.info("Fetching ZDR-compliant endpoints...");
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/endpoints/zdr", {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch {
    log.warn("Warning: could not fetch /endpoints/zdr (network) — ZDR data omitted.");
    return empty();
  }
  if (!res.ok) {
    log.warn(
      `Warning: /endpoints/zdr failed (HTTP ${res.status}) — requires auth; using provided key. ZDR data omitted.`,
    );
    return empty();
  }
  let data: unknown;
  try {
    data = (await res.json()) as { data?: unknown };
  } catch {
    log.warn("Warning: /endpoints/zdr returned non-JSON — ZDR data omitted.");
    return empty();
  }
  const arr = (data as { data?: unknown }).data;
  if (!isZdrPayload(arr)) {
    log.warn("Warning: /endpoints/zdr returned an unexpected payload — ZDR data omitted.");
    return empty();
  }
  writeCache("or-zdr-endpoints", { endpoints: arr });
  return buildZdrCatalog(arr);
}

export async function fetchModelEndpoints(
  slug: string,
  opts: { key?: string; log: OrCatalogLog; fresh?: boolean },
): Promise<EndpointFetch> {
  const { key, log, fresh } = opts;
  const cacheKey = `or-endpoints-${slug.replace(/\//g, "__")}`;
  const cached = fresh ? null : readCache<EndpointFetch>(cacheKey, ENDPOINT_CACHE_TTL);
  if (cached?.eps?.length) {
    log.info(`Using cached endpoints for ${slug}`);
    return cached;
  }
  const [author, model] = slug.split("/");
  if (!author || !model) {
    throw new Error(`-e expects "author/slug", got "${slug}" (e.g. deepseek/deepseek-v4-flash-0731)`);
  }
  const url = `https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(model)}/endpoints`;

  log.info(`Fetching endpoints for ${slug}...`);
  let res: Response;
  try {
    res = await fetch(url, key ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
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

/** Lower-case, hyphen-separated form of a display name: "Z AI" -> "z-ai",
 * "OpenInference" -> "openinference". */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** OpenRouter's routing slug for an endpoint's provider. The `tag` is
 * `<slug>[/<qualifier>...]`; the display name is not a slug ("OpenInference"
 * routes as `open-inference`). */
export function providerSlug(e: OREndpoint): string {
  const fromTag = e.tag.split("/")[0];
  if (fromTag) return fromTag;
  return slugify(e.provider_name);
}
