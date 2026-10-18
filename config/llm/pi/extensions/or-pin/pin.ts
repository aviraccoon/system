/**
 * Pure logic for `/or-pin`: parse the command, merge the pin into an
 * OpenRouter request payload, and summarize the endpoints a pin can name.
 *
 * pi writes `compat.openRouterRouting` into the request as `payload.provider`
 * (the openai-completions serializer), so a pin merges into that object
 * instead of replacing it — replacing it drops the routing config models.json
 * carries: zdr, data_collection, sort, throughput floors.
 *
 * A pin restricts; ranking an endpoint within the allowed set stays a config
 * lever (`sort`, `preferred_min_throughput` on the model override).
 *
 * No pi imports, so the merge's preservation rule is testable on its own.
 */

import { isZdrEndpoint, type OREndpoint, providerSlug, type ZdrCatalog } from "../shared/or-catalog";

export interface Pin {
  providers: string[];
}

export type PinCommand =
  | { kind: "pick" }
  | { kind: "clear" }
  | { kind: "set"; pin: Pin }
  | { kind: "invalid"; reason: string };

const CLEAR_WORDS = new Set(["off", "clear", "none"]);

/** OpenRouter provider slugs: lower-case, de-duplicated, order kept. */
export function parseProviders(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.toLowerCase().split(/[\s,]+/)) {
    if (part) seen.add(part);
  }
  return [...seen];
}

export function parsePinCommand(args: string): PinCommand {
  const trimmed = args.trim();
  if (trimmed === "") return { kind: "pick" };
  if (CLEAR_WORDS.has(trimmed.toLowerCase())) return { kind: "clear" };
  if (trimmed.startsWith("-")) return { kind: "invalid", reason: `unknown flag ${trimmed.split(/\s+/)[0]}` };

  const providers = parseProviders(trimmed);
  if (providers.length === 0) return { kind: "invalid", reason: "no provider slug given" };
  return { kind: "set", pin: { providers } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `only` plus `allow_fallbacks: false`: a pin that falls back is not a pin, so
 * a pinned provider that is down fails the request instead of routing
 * elsewhere.
 */
export function applyPin(payload: unknown, pin: Pin | undefined): unknown {
  if (!pin || !isRecord(payload)) return payload;
  const routing = isRecord(payload.provider) ? { ...payload.provider } : {};
  routing.only = [...pin.providers];
  routing.allow_fallbacks = false;
  return { ...payload, provider: routing };
}

export function pinSummary(pin: Pin): string {
  return `pinned to ${pin.providers.join(", ")}, fallbacks off`;
}

/** The OpenRouter page for a model — the provider list with prices and live
 * stats. A router alias (`~…-latest`) and a non-slug id have no page. */
export function modelPageUrl(modelId: string | undefined): string | undefined {
  if (!modelId || modelId.startsWith("~") || !modelId.includes("/")) return undefined;
  return `https://openrouter.ai/${modelId}`;
}

/** True for any provider routed through OpenRouter — the built-in provider or
 * a self-configured one (`openrouter-sidecar`). */
export function isOpenRouterModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
  if (!model) return false;
  if (model.provider?.startsWith("openrouter")) return true;
  return model.baseUrl?.includes("openrouter.ai") === true;
}

/** True when the composed model asserts OpenRouter's zero-data-retention filter.
 * OpenRouter applies that filter before `provider.only`, so a pinned provider
 * with no ZDR endpoint leaves the request with no endpoint at all (HTTP 404).
 * Takes `unknown`: pi's model `compat` is a union whose members do not all
 * carry the routing field. */
export function zdrAsserted(model: unknown): boolean {
  const compat = (model as { compat?: unknown } | undefined)?.compat;
  if (typeof compat !== "object" || compat === null) return false;
  const routing = (compat as Record<string, unknown>).openRouterRouting;
  if (typeof routing !== "object" || routing === null) return false;
  return (routing as Record<string, unknown>).zdr === true;
}

export interface ZdrVerdict {
  /** Rows the catalog marks as having no ZDR endpoint for this model. */
  ineligible: string[];
  /** Rows it cannot judge — the ZDR list is stale or absent. */
  unknown: string[];
}

/** Split the pinned providers by what the ZDR catalog says about them. A slug
 * the model does not serve at all is neither list; the caller checks that
 * separately. */
export function zdrVerdict(rows: PinRow[], providers: string[]): ZdrVerdict {
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const ineligible: string[] = [];
  const unknown: string[] = [];
  for (const slug of providers) {
    const row = bySlug.get(slug);
    if (!row) continue;
    if (row.zdr === false) ineligible.push(slug);
    else if (row.zdr === undefined) unknown.push(slug);
  }
  return { ineligible, unknown };
}

export interface PinRow {
  slug: string;
  quants: string[];
  /** undefined when the ZDR list is unavailable, so a row does not claim
   * "not eligible" from missing data. */
  zdr: boolean | undefined;
  up: boolean;
  contextLength: number;
  /** Stats of the cheapest of the provider's up endpoints — not necessarily the
   * one OpenRouter picks, which also weighs `sort` and any throughput floor the
   * model's routing config sets. */
  priceIn: number | undefined;
  priceOut: number | undefined;
  tpsP50: number | undefined;
  tpsP90: number | undefined;
  uptimePct: number | undefined;
}

/** OpenRouter quotes a price as a per-token string; a picker wants $/M. A
 * missing, blank, unparseable or negative (dynamic-pricing sentinel) value is
 * unknown. */
export function pricePerMillion(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return value * 1_000_000;
}

function totalPrice(e: OREndpoint): number {
  return (
    (pricePerMillion(e.pricing.prompt) ?? Number.POSITIVE_INFINITY) +
    (pricePerMillion(e.pricing.completion) ?? Number.POSITIVE_INFINITY)
  );
}

/** The cheapest of the provider's up endpoints, fastest p50 breaking a price
 * tie. None up falls back to the whole set, so a provider that is momentarily
 * down still gets stats worth reading. */
function cheapestUp(list: OREndpoint[]): OREndpoint | undefined {
  const up = list.filter((e) => e.status === 0);
  const pool = up.length > 0 ? up : list;
  return pool.reduce<OREndpoint | undefined>((best, e) => {
    if (!best) return e;
    const cheaper = totalPrice(e) - totalPrice(best);
    if (cheaper < 0) return e;
    if (cheaper === 0 && (e.throughput_last_30m?.p50 ?? -1) > (best.throughput_last_30m?.p50 ?? -1)) return e;
    return best;
  }, undefined);
}

/** ZDR-eligible and up first, then the rest of the up providers cheapest first:
 * the order the choice is actually made in. */
function rank(row: PinRow): number {
  if (!row.up) return 2;
  return row.zdr === true ? 0 : 1;
}

function rowPrice(row: PinRow): number {
  return (row.priceIn ?? Number.POSITIVE_INFINITY) + (row.priceOut ?? Number.POSITIVE_INFINITY);
}

/** One row per provider slug — the unit a pin names. Quantization variants of
 * one provider collapse into the row; eligibility and availability are true when
 * any variant is, while the price, throughput and uptime columns come from the
 * single endpoint `cheapestUp` picks. */
export function buildPinRows(eps: OREndpoint[], zdr: ZdrCatalog): PinRow[] {
  const zdrKnown = zdr.tags.size > 0;
  const groups = new Map<string, OREndpoint[]>();
  for (const e of eps) {
    const slug = providerSlug(e);
    const list = groups.get(slug);
    if (list) list.push(e);
    else groups.set(slug, [e]);
  }

  const rows = [...groups.entries()].map(([slug, list]) => {
    const chosen = cheapestUp(list);
    return {
      slug,
      quants: [...new Set(list.map((e) => e.quantization ?? "unknown"))],
      zdr: zdrKnown ? list.some((e) => isZdrEndpoint(zdr, e)) : undefined,
      up: list.some((e) => e.status === 0),
      contextLength: Math.max(...list.map((e) => e.context_length)),
      priceIn: chosen ? pricePerMillion(chosen.pricing.prompt) : undefined,
      priceOut: chosen ? pricePerMillion(chosen.pricing.completion) : undefined,
      tpsP50: chosen?.throughput_last_30m?.p50,
      tpsP90: chosen?.throughput_last_30m?.p90,
      uptimePct: chosen?.uptime_last_5m ?? chosen?.uptime_last_30m ?? undefined,
    };
  });

  return rows.sort((a, b) => rank(a) - rank(b) || rowPrice(a) - rowPrice(b) || a.slug.localeCompare(b.slug));
}

export function formatPinRow(row: PinRow, active: boolean): string {
  const mark = active ? "*" : " ";
  const zdr = row.zdr === true ? "zdr" : row.zdr === false ? "no-zdr" : "zdr?";
  const price = `${fmtPrice(row.priceIn)}/${fmtPrice(row.priceOut)}`;
  const tps = row.tpsP50 === undefined ? "--" : `${Math.round(row.tpsP50)}/${Math.round(row.tpsP90 ?? row.tpsP50)}`;
  const uptime = row.uptimePct === undefined ? "--" : `${Math.round(row.uptimePct)}%`;
  const down = row.up ? "" : "  DOWN";
  return `${mark} ${row.slug}  ${zdr}  ${row.quants.join("/")}  ${price}  ${tps} tok/s  ${uptime}  ${formatContext(row.contextLength)}${down}`;
}

function fmtPrice(perMillion: number | undefined): string {
  return perMillion === undefined ? "--" : `$${perMillion.toFixed(3)}`;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}
