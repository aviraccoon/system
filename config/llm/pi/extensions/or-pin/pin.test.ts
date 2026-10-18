import { describe, expect, test } from "bun:test";
import { buildZdrCatalog, type OREndpoint } from "../shared/or-catalog";
import {
  applyPin,
  buildPinRows,
  formatPinRow,
  isOpenRouterModel,
  modelPageUrl,
  parsePinCommand,
  parseProviders,
  pinSummary,
  pricePerMillion,
  zdrAsserted,
  zdrVerdict,
} from "./pin";

function endpoint(over: Partial<OREndpoint> = {}): OREndpoint {
  return {
    name: "DeepInfra | deepseek/deepseek-v4.1-flash",
    model_id: "deepseek/deepseek-v4.1-flash",
    provider_name: "DeepInfra",
    tag: "deepinfra/fp8",
    quantization: "fp8",
    status: 0,
    context_length: 1_048_576,
    is_byok: false,
    pricing: { prompt: "0.000000112", completion: "0.000000336" },
    throughput_last_30m: null,
    latency_last_30m: null,
    uptime_last_5m: 100,
    uptime_last_30m: 100,
    uptime_last_1d: 99,
    ...over,
  };
}

describe("parseProviders", () => {
  test("splits on commas and whitespace, lower-cases, de-duplicates", () => {
    expect(parseProviders(" DeepSeek, novita  deepseek ")).toEqual(["deepseek", "novita"]);
  });

  test("empty input yields no providers", () => {
    expect(parseProviders("  ,  ")).toEqual([]);
  });
});

describe("parsePinCommand", () => {
  test("no argument asks for the picker", () => {
    expect(parsePinCommand("")).toEqual({ kind: "pick" });
    expect(parsePinCommand("   ")).toEqual({ kind: "pick" });
  });

  test("clear words clear the pin", () => {
    expect(parsePinCommand("off")).toEqual({ kind: "clear" });
    expect(parsePinCommand("clear")).toEqual({ kind: "clear" });
    expect(parsePinCommand("NONE")).toEqual({ kind: "clear" });
  });

  test("slugs after the command pin directly", () => {
    expect(parsePinCommand("deepseek, novita")).toEqual({ kind: "set", pin: { providers: ["deepseek", "novita"] } });
    expect(parsePinCommand("  DEEPSEEK ")).toEqual({ kind: "set", pin: { providers: ["deepseek"] } });
  });

  test("an unknown flag is named in the refusal", () => {
    expect(parsePinCommand("--favorite deepseek")).toEqual({ kind: "invalid", reason: "unknown flag --favorite" });
  });
});

describe("applyPin", () => {
  test("merges into the routing object pi built, keeping every configured key", () => {
    const payload = {
      model: "deepseek/deepseek-v4.1-flash",
      provider: {
        zdr: true,
        data_collection: "deny",
        sort: "price",
        preferred_min_throughput: { p50: 40, p90: 50 },
        // A pin wins over what the routing config already set.
        only: ["novita"],
        allow_fallbacks: true,
      },
    };
    const pinned = applyPin(payload, { providers: ["deepseek"] }) as {
      provider: Record<string, unknown>;
    };
    expect(pinned.provider).toEqual({
      zdr: true,
      data_collection: "deny",
      sort: "price",
      preferred_min_throughput: { p50: 40, p90: 50 },
      only: ["deepseek"],
      allow_fallbacks: false,
    });
  });

  test("leaves the caller's payload untouched", () => {
    const payload = { provider: { zdr: true }, model: "x" };
    applyPin(payload, { providers: ["deepseek"] });
    expect(payload.provider).toEqual({ zdr: true });
  });

  test("creates the routing object when the payload has none", () => {
    expect(applyPin({ model: "x" }, { providers: ["novita"] })).toEqual({
      model: "x",
      provider: { only: ["novita"], allow_fallbacks: false },
    });
  });

  test("an absent pin or a payload that is not an object passes through", () => {
    const payload = { provider: { zdr: true } };
    expect(applyPin(payload, undefined)).toBe(payload);
    expect(applyPin("not a payload", { providers: ["x"] })).toBe("not a payload");
    expect(applyPin([1, 2], { providers: ["x"] })).toEqual([1, 2]);
  });
});

describe("pinSummary", () => {
  test("names the providers and the fallback rule", () => {
    expect(pinSummary({ providers: ["deepseek", "novita"] })).toBe("pinned to deepseek, novita, fallbacks off");
  });
});

describe("isOpenRouterModel", () => {
  test("accepts the built-in provider, a self-configured one, and an OpenRouter baseUrl", () => {
    expect(isOpenRouterModel({ provider: "openrouter" })).toBe(true);
    expect(isOpenRouterModel({ provider: "openrouter-sidecar" })).toBe(true);
    expect(isOpenRouterModel({ provider: "custom", baseUrl: "https://openrouter.ai/api/v1" })).toBe(true);
  });

  test("rejects other providers and a missing model", () => {
    expect(isOpenRouterModel({ provider: "anthropic" })).toBe(false);
    expect(isOpenRouterModel({ provider: "zai", baseUrl: "https://api.z.ai/api/paas/v4" })).toBe(false);
    expect(isOpenRouterModel(undefined)).toBe(false);
  });
});

describe("buildPinRows", () => {
  const eligible = endpoint();
  const catalog = buildZdrCatalog([eligible]);

  test("collapses quantization variants of one provider into a row", () => {
    const rows = buildPinRows(
      [
        endpoint(),
        endpoint({ quantization: "fp8", tag: "deepinfra/fp8/flex" }),
        endpoint({ provider_name: "Novita", tag: "novita/fp8", quantization: null }),
      ],
      buildZdrCatalog([]),
    );
    expect(rows.map((r) => r.slug)).toEqual(["deepinfra", "novita"]);
    expect(rows[0].quants).toEqual(["fp8"]);
    expect(rows[1].quants).toEqual(["unknown"]);
  });

  test("a row is ZDR-eligible when any of its variants is", () => {
    const rows = buildPinRows([eligible, endpoint({ tag: "deepinfra/fp8/flex" })], catalog);
    expect(rows).toHaveLength(1);
    expect(rows[0].zdr).toBe(true);
  });

  test("a row with no eligible variant reports false once the list is loaded", () => {
    const rows = buildPinRows([endpoint({ provider_name: "Alibaba", tag: "alibaba", model_id: "x/y" })], catalog);
    expect(rows[0].zdr).toBe(false);
  });

  test("eligibility is unknown, not false, while the ZDR list is empty", () => {
    const rows = buildPinRows([eligible], buildZdrCatalog([]));
    expect(rows[0].zdr).toBeUndefined();
  });

  test("keeps the largest context window and whether any variant is up", () => {
    const rows = buildPinRows(
      [
        endpoint({ tag: "deepinfra/fp8/flex", context_length: 1_048_576, status: 0 }),
        endpoint({ context_length: 1_000_000, status: 1 }),
      ],
      buildZdrCatalog([]),
    );
    expect(rows[0].contextLength).toBe(1_048_576);
    expect(rows[0].up).toBe(true);
    expect(buildPinRows([endpoint({ status: 1 })], buildZdrCatalog([]))[0].up).toBe(false);
  });
});

describe("buildPinRows stats and order", () => {
  const stats = (p50: number) => ({ p50, p75: 0, p90: 0, p99: 0 });
  const cheapDown = endpoint({
    provider_name: "BaseTen",
    tag: "baseten/fast",
    status: 1,
    pricing: { prompt: "0.00000005", completion: "0.0000001" },
    throughput_last_30m: stats(200),
    uptime_last_5m: 50,
  });
  const midUp = endpoint({
    provider_name: "BaseTen",
    tag: "baseten",
    status: 0,
    pricing: { prompt: "0.0000003", completion: "0.0000012" },
    throughput_last_30m: stats(100),
    uptime_last_5m: 99.5,
  });
  const cheapUp = endpoint({
    provider_name: "BaseTen",
    tag: "baseten/us",
    status: 0,
    pricing: { prompt: "0.0000001", completion: "0.0000004" },
    throughput_last_30m: stats(20),
    uptime_last_5m: 100,
  });

  test("describes the cheapest up endpoint, not a cheaper one that is down", () => {
    const rows = buildPinRows([cheapDown, midUp, cheapUp], buildZdrCatalog([]));
    expect(rows).toHaveLength(1);
    expect(rows[0].priceIn).toBeCloseTo(0.1, 6);
    expect(rows[0].priceOut).toBeCloseTo(0.4, 6);
    expect(rows[0].tpsP50).toBe(20);
    expect(rows[0].uptimePct).toBe(100);
    expect(rows[0].up).toBe(true);
    expect(rows[0].quants).toEqual(["fp8"]);
  });

  test("falls back to the whole set when no variant is up", () => {
    const rows = buildPinRows([cheapDown], buildZdrCatalog([]));
    expect(rows[0].up).toBe(false);
    expect(rows[0].priceIn).toBeCloseTo(0.05, 6);
  });

  test("orders ZDR-eligible and up first, then the rest by price", () => {
    const eligibleExpensive = endpoint({
      provider_name: "CoreWeave",
      tag: "coreweave/fp8",
      pricing: { prompt: "0.0000005", completion: "0.000002" },
    });
    const eligibleCheap = endpoint({
      provider_name: "DeepInfra",
      tag: "deepinfra/fp8",
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
    });
    const ineligible = endpoint({
      provider_name: "Alibaba",
      tag: "alibaba",
      model_id: "x/y",
      pricing: { prompt: "0.00000005", completion: "0.0000002" },
    });
    const rows = buildPinRows(
      [ineligible, eligibleExpensive, eligibleCheap],
      buildZdrCatalog([eligibleCheap, eligibleExpensive]),
    );
    expect(rows.map((row) => row.slug)).toEqual(["deepinfra", "coreweave", "alibaba"]);
  });

  test("puts an up provider above a down one that is cheaper", () => {
    const downCheap = endpoint({
      provider_name: "Alibaba",
      tag: "alibaba",
      model_id: "x/y",
      status: 1,
      pricing: { prompt: "0.00000005", completion: "0.0000002" },
    });
    const upDear = endpoint({
      provider_name: "CoreWeave",
      tag: "coreweave/fp8",
      pricing: { prompt: "0.0000005", completion: "0.000002" },
    });
    const rows = buildPinRows([downCheap, upDear], buildZdrCatalog([]));
    expect(rows.map((row) => row.slug)).toEqual(["coreweave", "alibaba"]);
  });
});

describe("zdrAsserted", () => {
  test("reads the zdr flag out of the composed routing compat", () => {
    expect(zdrAsserted({ compat: { openRouterRouting: { zdr: true, data_collection: "deny" } } })).toBe(true);
  });

  test("false for a model without the assertion, and for shapes it cannot read", () => {
    expect(zdrAsserted(undefined)).toBe(false);
    expect(zdrAsserted({})).toBe(false);
    expect(zdrAsserted({ compat: {} })).toBe(false);
    expect(zdrAsserted({ compat: { openRouterRouting: {} } })).toBe(false);
    expect(zdrAsserted({ compat: { openRouterRouting: { zdr: false } } })).toBe(false);
    // A provider-scoped compat shape with no routing object at all.
    expect(zdrAsserted({ compat: { supportsStrictMode: false } })).toBe(false);
    expect(zdrAsserted({ compat: "nonsense" })).toBe(false);
  });
});

describe("zdrVerdict", () => {
  const rows = buildPinRows(
    [
      endpoint({ provider_name: "DeepInfra", tag: "deepinfra/fp8" }),
      endpoint({ provider_name: "Alibaba", tag: "alibaba", model_id: "x/y" }),
    ],
    buildZdrCatalog([endpoint({ provider_name: "DeepInfra", tag: "deepinfra/fp8" })]),
  );

  test("splits the pinned providers into ineligible and unknowable", () => {
    expect(zdrVerdict(rows, ["alibaba"])).toEqual({ ineligible: ["alibaba"], unknown: [] });
    expect(zdrVerdict(rows, ["deepinfra"])).toEqual({ ineligible: [], unknown: [] });
  });

  test("reports unknown when the ZDR list could not be read", () => {
    const blind = buildPinRows([endpoint()], buildZdrCatalog([]));
    expect(zdrVerdict(blind, ["deepinfra"])).toEqual({ ineligible: [], unknown: ["deepinfra"] });
  });

  test("says nothing about a slug the model does not serve", () => {
    expect(zdrVerdict(rows, ["novita"])).toEqual({ ineligible: [], unknown: [] });
  });
});

describe("pricePerMillion", () => {
  test("converts a per-token price string to $/M", () => {
    expect(pricePerMillion("0.000000112")).toBeCloseTo(0.112, 6);
    expect(pricePerMillion("0")).toBe(0);
  });

  test("treats missing, blank, unparseable and dynamic values as unknown", () => {
    expect(pricePerMillion(undefined)).toBeUndefined();
    expect(pricePerMillion("  ")).toBeUndefined();
    expect(pricePerMillion("dynamic")).toBeUndefined();
    expect(pricePerMillion("-1")).toBeUndefined();
  });
});

describe("modelPageUrl", () => {
  test("builds the model's page from an OpenRouter slug", () => {
    expect(modelPageUrl("deepseek/deepseek-v4.1-flash")).toBe("https://openrouter.ai/deepseek/deepseek-v4.1-flash");
  });

  test("no page for an alias, a bare id, or nothing", () => {
    expect(modelPageUrl("~deepseek/deepseek-flash-latest")).toBeUndefined();
    expect(modelPageUrl("sonnet")).toBeUndefined();
    expect(modelPageUrl(undefined)).toBeUndefined();
  });
});

describe("formatPinRow", () => {
  // The exact strings are the picker's visible labels, so they are pinned as the
  // rendering contract rather than as a copy of the formatting code.
  const row = {
    slug: "deepinfra",
    quants: ["fp8"],
    zdr: true,
    up: true,
    contextLength: 1_048_576,
    priceIn: 0.112,
    priceOut: 0.336,
    tpsP50: 40,
    tpsP90: 55,
    uptimePct: 100,
  };

  test("marks the active pin, prices it, and shortens the context window", () => {
    expect(formatPinRow(row, true)).toBe("* deepinfra  zdr  fp8  $0.112/$0.336  40/55 tok/s  100%  1.0M");
    expect(formatPinRow({ ...row, contextLength: 128_000 }, false)).toBe(
      "  deepinfra  zdr  fp8  $0.112/$0.336  40/55 tok/s  100%  128k",
    );
  });

  test("leaves out what the catalog did not report", () => {
    const blind = {
      slug: "alibaba",
      quants: ["unknown"],
      zdr: undefined,
      up: true,
      contextLength: 1_000_000,
      priceIn: undefined,
      priceOut: undefined,
      tpsP50: undefined,
      tpsP90: undefined,
      uptimePct: undefined,
    };
    expect(formatPinRow(blind, false)).toBe("  alibaba  zdr?  unknown  --/--  -- tok/s  --  1.0M");
  });

  test("falls back to p50 when there is no p90, and flags a row with no up endpoint", () => {
    const down = { ...row, slug: "baseten", zdr: false, up: false, tpsP90: undefined, uptimePct: 42.6 };
    expect(formatPinRow(down, false)).toBe("  baseten  no-zdr  fp8  $0.112/$0.336  40/40 tok/s  43%  1.0M  DOWN");
  });
});
