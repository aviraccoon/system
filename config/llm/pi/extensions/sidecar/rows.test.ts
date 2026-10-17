import { describe, expect, test } from "bun:test";
import type { ModelEntry } from "../shared/model-roles";
import { type AvailableModel, buildRows, placeInChain, splitRef } from "./rows";

function available(ref: string): AvailableModel {
  const slash = ref.indexOf("/");
  return {
    ref,
    name: `${ref} (name)`,
    provider: ref.slice(0, slash),
    modelId: ref.slice(slash + 1),
  };
}

// ── splitRef ──

describe("splitRef", () => {
  test("splits at the first slash, so a nested model id survives", () => {
    expect(splitRef("openrouter/deepseek/deepseek-v4.1-flash")).toEqual({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4.1-flash",
    });
  });

  test("a ref without a slash reads as all model id", () => {
    expect(splitRef("orphan")).toEqual({ provider: "", modelId: "orphan" });
  });
});

// ── buildRows ──

describe("buildRows", () => {
  const chain: ModelEntry[] = [{ ref: "omlx/live" }, { ref: "omlx/gone" }, { ref: "zai/other" }];
  const models = [available("omlx/gone"), available("omlx/live"), available("zai/other"), available("zai/extra")];

  test("keeps every chain member, in chain order, numbered by chain position", () => {
    const rows = buildRows(chain, models);
    expect(rows.slice(0, 3)).toEqual([
      {
        ref: "omlx/live",
        name: "omlx/live (name)",
        provider: "omlx",
        modelId: "live",
        inChain: true,
        position: 1,
        available: true,
      },
      {
        ref: "omlx/gone",
        name: "omlx/gone (name)",
        provider: "omlx",
        modelId: "gone",
        inChain: true,
        position: 2,
        available: true,
      },
      {
        ref: "zai/other",
        name: "zai/other (name)",
        provider: "zai",
        modelId: "other",
        inChain: true,
        position: 3,
        available: true,
      },
    ]);
  });

  test("a chain member with no available model keeps its row and its position", () => {
    const rows = buildRows([{ ref: "omlx/live" }, { ref: "omlx/missing" }, { ref: "zai/other" }], models);
    expect(rows.slice(0, 3).map((r) => [r.ref, r.position, r.available])).toEqual([
      ["omlx/live", 1, true],
      ["omlx/missing", 2, false],
      ["zai/other", 3, true],
    ]);
  });

  test("an unavailable member still reports provider and model id, split from the ref", () => {
    const [row] = buildRows([{ ref: "openrouter/deepseek/gone" }], []);
    expect(row).toMatchObject({ provider: "openrouter", modelId: "deepseek/gone", name: "openrouter/deepseek/gone" });
  });

  test("a ref with no slash becomes a row with an empty provider", () => {
    const [row] = buildRows([{ ref: "orphan" }], []);
    expect(row).toMatchObject({ provider: "", modelId: "orphan", available: false, position: 1 });
  });

  test("a non-string ref still gets a row instead of throwing", () => {
    const [row] = buildRows([{ ref: 7 } as unknown as ModelEntry], []);
    expect(row).toMatchObject({ ref: "7", modelId: "7", available: false, position: 1 });
  });

  test("positions stay contiguous, so the largest one equals the chain length", () => {
    const rows = buildRows([{ ref: "a/gone" }, { ref: "b/gone" }, { ref: "c/live" }], [available("c/live")]);
    expect(rows.filter((r) => r.inChain).map((r) => r.position)).toEqual([1, 2, 3]);
    expect(rows.filter((r) => r.inChain).at(-1)?.position).toBe(3);
  });

  test("tail holds the available models outside the chain, unnumbered", () => {
    const rows = buildRows(chain, models);
    expect(rows.slice(3)).toEqual([{ ...available("zai/extra"), inChain: false, position: 0, available: true }]);
  });

  test("a chain member is not repeated in the tail", () => {
    const rows = buildRows([{ ref: "zai/other" }], [available("zai/other")]);
    expect(rows).toHaveLength(1);
  });

  test("with an empty chain every available model is tail", () => {
    const rows = buildRows([], [available("a/one"), available("b/two")]);
    expect(rows.map((r) => [r.ref, r.inChain, r.position])).toEqual([
      ["a/one", false, 0],
      ["b/two", false, 0],
    ]);
  });
});

// ── placeInChain ──

describe("placeInChain", () => {
  const chain: ModelEntry[] = [{ ref: "a/first" }, { ref: "b/second" }];
  const added: ModelEntry[] = [{ ref: "c/added" }, { ref: "d/added" }];

  test("head puts the batch in front, in its own order", () => {
    expect(placeInChain(chain, added, "head").map((m) => m.ref)).toEqual(["c/added", "d/added", "a/first", "b/second"]);
  });

  test("tail appends the batch in its own order", () => {
    expect(placeInChain(chain, added, "tail").map((m) => m.ref)).toEqual(["a/first", "b/second", "c/added", "d/added"]);
  });
});
