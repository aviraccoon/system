import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as oc from "./or-catalog";

// The cache dir is read per call, so the override only has to be set before the
// first cache operation.
let cacheDir = "";

beforeAll(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "or-catalog-test-"));
  process.env.OR_CATALOG_CACHE_DIR = cacheDir;
});

afterAll(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env.OR_CATALOG_CACHE_DIR;
});

const silentLog = { info: () => {}, warn: () => {} };

function endpoint(over: Partial<oc.OREndpoint> = {}): oc.OREndpoint {
  return {
    name: "DeepSeek | deepseek/deepseek-v4.1-flash",
    model_id: "deepseek/deepseek-v4.1-flash",
    provider_name: "DeepSeek",
    tag: "deepseek/fp8",
    quantization: "fp8",
    status: 0,
    context_length: 1_048_576,
    is_byok: false,
    pricing: { prompt: "0.0000003", completion: "0.0000012" },
    throughput_last_30m: null,
    latency_last_30m: null,
    uptime_last_5m: 100,
    uptime_last_30m: 100,
    uptime_last_1d: 99.9,
    ...over,
  };
}

describe("catalog row validation", () => {
  test("accepts a row with a tag and a string prompt price", () => {
    expect(oc.catalogRowOk(endpoint())).toBe(true);
  });

  test("rejects rows missing a tag or a prompt price", () => {
    expect(oc.catalogRowOk(null)).toBe(false);
    expect(oc.catalogRowOk("deepseek/fp8")).toBe(false);
    expect(oc.catalogRowOk({ tag: "deepseek/fp8" })).toBe(false);
    expect(oc.catalogRowOk({ tag: "deepseek/fp8", pricing: { prompt: 3 } })).toBe(false);
  });

  test("a payload is only usable when non-empty and every row is well formed", () => {
    expect(oc.isZdrPayload([endpoint()])).toBe(true);
    expect(oc.isZdrPayload([])).toBe(false);
    expect(oc.isZdrPayload({ endpoints: [endpoint()] })).toBe(false);
    expect(oc.isZdrPayload([endpoint(), { tag: "x" }])).toBe(false);
  });
});

describe("ZDR eligibility", () => {
  test("indexes (model_id, tag) pairs, bare tags, and endpoints by model", () => {
    const catalog = oc.buildZdrCatalog([
      endpoint(),
      endpoint({ model_id: undefined, tag: "ionstream" }),
      endpoint({ model_id: "deepseek/deepseek-v4.1-flash", tag: "deepseek/fp8", provider_name: "DeepSeek" }),
    ]);
    expect(catalog.zdr.has("deepseek/deepseek-v4.1-flash|deepseek/fp8")).toBe(true);
    expect(catalog.tags.has("ionstream")).toBe(true);
    expect(catalog.byModel.get("deepseek/deepseek-v4.1-flash")).toHaveLength(2);
    expect(catalog.byModel.has("undefined")).toBe(false);
  });

  test("matches an exact (model_id, tag) pair", () => {
    const catalog = oc.buildZdrCatalog([endpoint()]);
    expect(oc.isZdrEndpoint(catalog, endpoint())).toBe(true);
  });

  test("falls back to the bare tag when the row carries no model_id", () => {
    const catalog = oc.buildZdrCatalog([endpoint({ model_id: undefined, tag: "ionstream" })]);
    expect(oc.isZdrEndpoint(catalog, endpoint({ model_id: undefined, tag: "ionstream" }))).toBe(true);
  });

  test("the tag fallback also matches when the model_id is absent from the list", () => {
    // Documented consequence of the fallback: /endpoints/zdr omits model_id on
    // some rows, so a tag hit counts even for a model the list does not name.
    const catalog = oc.buildZdrCatalog([endpoint({ model_id: undefined, tag: "deepinfra/fp8" })]);
    expect(
      oc.isZdrEndpoint(catalog, endpoint({ model_id: "deepseek/deepseek-v4.1-flash", tag: "deepinfra/fp8" })),
    ).toBe(true);
  });

  test("does not match an unrelated tag", () => {
    const catalog = oc.buildZdrCatalog([endpoint()]);
    expect(oc.isZdrEndpoint(catalog, endpoint({ model_id: "x/y", tag: "streamlake/fp8" }))).toBe(false);
  });
});

describe("pickRoutable", () => {
  test("drops endpoints whose status is not 0", () => {
    const up = endpoint();
    const down = endpoint({ provider_name: "Novita", tag: "novita/fp8", status: 1 });
    expect(oc.pickRoutable([up, down], oc.buildZdrCatalog([]))).toEqual([up]);
  });

  test("keeps every up endpoint when the ZDR list did not load", () => {
    const a = endpoint();
    const b = endpoint({ provider_name: "Novita", tag: "novita/fp8" });
    expect(oc.pickRoutable([a, b], oc.buildZdrCatalog([]))).toHaveLength(2);
  });

  test("filters by ZDR eligibility once the list has rows", () => {
    const eligible = endpoint();
    const other = endpoint({ provider_name: "StreamLake", tag: "streamlake/fp8" });
    const catalog = oc.buildZdrCatalog([eligible]);
    expect(oc.pickRoutable([eligible, other], catalog)).toEqual([eligible]);
  });
});

describe("providerSlug", () => {
  test("takes the slug from the tag's first segment", () => {
    expect(oc.providerSlug(endpoint({ provider_name: "OpenInference", tag: "open-inference/fp4" }))).toBe(
      "open-inference",
    );
    expect(oc.providerSlug(endpoint({ provider_name: "BaseTen", tag: "baseten" }))).toBe("baseten");
  });

  test("falls back to a slugified display name", () => {
    expect(oc.providerSlug(endpoint({ provider_name: "OpenInference", tag: "" }))).toBe("openinference");
    expect(oc.providerSlug(endpoint({ provider_name: "Sail Research", tag: "" }))).toBe("sail-research");
  });
});

describe("file cache", () => {
  test("round-trips a payload", () => {
    oc.writeCache("round-trip", { model_id: "deepseek/x" });
    expect(oc.readCache<{ model_id: string }>("round-trip")).toEqual({ model_id: "deepseek/x" });
    expect(join(oc.cacheDir(), "round-trip.json").startsWith(cacheDir)).toBe(true);
  });

  test("a missing entry reads as null", () => {
    expect(oc.readCache("never-written")).toBeNull();
  });

  test("an entry older than its ttl reads as null, and one inside it reads back", () => {
    oc.writeCache("stale", { v: 1 });
    // utimesSync stores whole seconds, so the ttl must not sit on the age.
    const stamp = Date.now() / 1000 - 60 * 60;
    utimesSync(join(oc.cacheDir(), "stale.json"), stamp, stamp);
    expect(oc.readCache("stale", 60 * 15 * 1000)).toBeNull();
    expect(oc.readCache<{ v: number }>("stale", 60 * 120 * 1000)).toEqual({ v: 1 });
  });
});

describe("fetchZdrCatalog", () => {
  test("serves the cached catalog without a credential", async () => {
    oc.writeCache("or-zdr-endpoints", { endpoints: [endpoint()] });
    const warnings: string[] = [];
    const catalog = await oc.fetchZdrCatalog({
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    expect(catalog.zdr.has("deepseek/deepseek-v4.1-flash|deepseek/fp8")).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("degrades to an empty catalog, with a warning, when there is no cache and no key", async () => {
    oc.writeCache("or-zdr-endpoints", { endpoints: [] });
    const warnings: string[] = [];
    const catalog = await oc.fetchZdrCatalog({
      log: { info: () => {}, warn: (m) => warnings.push(m) },
    });
    expect(catalog.tags.size).toBe(0);
    expect(catalog.zdr.size).toBe(0);
    expect(warnings).toEqual(["Warning: no OpenRouter credential for /endpoints/zdr — ZDR data omitted."]);
  });
});

describe("fetchModelEndpoints", () => {
  test("rejects a slug that is not author/model without a request", async () => {
    return expect(oc.fetchModelEndpoints("deepseek", { log: silentLog })).rejects.toThrow(
      '-e expects "author/slug", got "deepseek"',
    );
  });
});
