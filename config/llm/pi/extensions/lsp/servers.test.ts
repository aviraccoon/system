import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DetectedServer } from "./servers";
import {
  configForTsFlavor,
  findGatedLintersForFile,
  findServerByExtension,
  getTsServerMemory,
  KNOWN_SERVERS,
  readServerOverrides,
  serverDisplayName,
  serversForFile,
} from "./servers";

describe("KNOWN_SERVERS", () => {
  test("has typescript-language-server", () => {
    const ts = KNOWN_SERVERS["typescript-language-server"];
    expect(ts).toBeDefined();
    expect(ts.fileTypes).toContain(".ts");
    expect(ts.fileTypes).toContain(".tsx");
    expect(ts.command).toBe("typescript-language-server");
  });

  test("typescript roots at the project file even past a nearer package.json", () => {
    const ts = KNOWN_SERVERS["typescript-language-server"];
    expect(ts.rootStrategy).toBe("markers");
    expect(ts.rootMarkers).toEqual([["tsconfig.json", "jsconfig.json"], "package.json"]);
  });

  test("has rust-analyzer", () => {
    const rs = KNOWN_SERVERS["rust-analyzer"];
    expect(rs).toBeDefined();
    expect(rs.fileTypes).toContain(".rs");
    expect(rs.rootMarkers).toContain("Cargo.toml");
  });

  test("has nixd", () => {
    const nix = KNOWN_SERVERS.nixd;
    expect(nix).toBeDefined();
    expect(nix.fileTypes).toContain(".nix");
    expect(nix.rootMarkers).toContain("flake.nix");
  });

  test("has gopls", () => {
    const go = KNOWN_SERVERS.gopls;
    expect(go).toBeDefined();
    expect(go.fileTypes).toContain(".go");
    expect(go.command).toBe("gopls");
  });

  test("has pyright", () => {
    const py = KNOWN_SERVERS.pyright;
    expect(py).toBeDefined();
    expect(py.fileTypes).toContain(".py");
    expect(py.command).toBe("pyright-langserver");
  });

  test("has slint-lsp", () => {
    const slint = KNOWN_SERVERS["slint-lsp"];
    expect(slint).toBeDefined();
    expect(slint.fileTypes).toContain(".slint");
    expect(slint.command).toBe("slint-lsp");
    expect(slint.args).toEqual([]);
    expect(slint.rootMarkers).toContain("Cargo.toml");
  });
  test("has oxlint, repo-gated and never lazy-starts", () => {
    const ox = KNOWN_SERVERS.oxlint;
    expect(ox).toBeDefined();
    expect(ox.command).toBe("oxlint");
    expect(ox.args).toEqual(["--lsp"]);
    expect(ox.fileTypes).toContain(".ts");
    expect(ox.fileTypes).toContain(".js");
    for (const m of [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts"]) {
      expect(ox.rootMarkers).toContain(m);
    }
    expect(ox.allowLazy).toBe(false);
  });

  test("has biome, repo-gated via lsp-proxy and never lazy-starts", () => {
    const b = KNOWN_SERVERS.biome;
    expect(b).toBeDefined();
    expect(b.command).toBe("biome");
    expect(b.args).toEqual(["lsp-proxy"]);
    expect(b.fileTypes).toContain(".ts");
    expect(b.fileTypes).toContain(".js");
    expect(b.fileTypes).toContain(".json");
    expect(b.fileTypes).toContain(".jsonc");
    expect(b.rootMarkers).toContain("biome.json");
    expect(b.rootMarkers).toContain("biome.jsonc");
    expect(b.allowLazy).toBe(false);
  });
});

describe("serversForFile", () => {
  const mockDetected: DetectedServer[] = [
    {
      name: "typescript-language-server",
      config: KNOWN_SERVERS["typescript-language-server"],
      resolvedCommand: "/usr/bin/tsserver",
    },
    { name: "rust-analyzer", config: KNOWN_SERVERS["rust-analyzer"], resolvedCommand: "/usr/bin/rust-analyzer" },
    { name: "nixd", config: KNOWN_SERVERS.nixd, resolvedCommand: "/usr/bin/nixd" },
  ];

  test("matches .ts files to typescript-language-server", () => {
    const result = serversForFile("src/main.ts", mockDetected);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("typescript-language-server");
  });

  test("matches .tsx files", () => {
    const result = serversForFile("components/App.tsx", mockDetected);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("typescript-language-server");
  });

  test("matches .rs files to rust-analyzer", () => {
    const result = serversForFile("src/main.rs", mockDetected);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("rust-analyzer");
  });

  test("matches .nix files to nixd", () => {
    const result = serversForFile("flake.nix", mockDetected);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("nixd");
  });

  test("returns empty for unknown extensions", () => {
    const result = serversForFile("data.csv", mockDetected);
    expect(result).toHaveLength(0);
  });

  test("matches .jsx and .mjs", () => {
    expect(serversForFile("app.jsx", mockDetected)).toHaveLength(1);
    expect(serversForFile("utils.mjs", mockDetected)).toHaveLength(1);
  });
});

describe("getTsServerMemory", () => {
  test("returns at least 4096", () => {
    expect(getTsServerMemory()).toBeGreaterThanOrEqual(4096);
  });

  test("returns roughly 1/8 of system memory", () => {
    const systemMB = Math.floor(os.totalmem() / (1024 * 1024));
    const expected = Math.max(4096, Math.floor(systemMB / 8));
    expect(getTsServerMemory()).toBe(expected);
  });

  test("is used in typescript-language-server config", () => {
    const ts = KNOWN_SERVERS["typescript-language-server"];
    expect(ts.initOptions?.maxTsServerMemory).toBe(getTsServerMemory());
  });
});

describe("findServerByExtension", () => {
  // Uses real PATH so results depend on what's installed,
  // but we can test the matching logic with a cwd that has no local bins.

  test("finds typescript-language-server for .ts files", () => {
    const result = findServerByExtension("src/index.ts", "/tmp");
    // Will be non-null only if typescript-language-server is on PATH
    if (result) {
      expect(result.name).toBe("typescript-language-server");
      expect(result.config.fileTypes).toContain(".ts");
    }
  });

  test("finds nixd for .nix files", () => {
    const result = findServerByExtension("flake.nix", "/tmp");
    if (result) {
      expect(result.name).toBe("nixd");
    }
  });

  test("returns null for unknown extensions", () => {
    const result = findServerByExtension("data.csv", "/tmp");
    expect(result).toBeNull();
  });
});

describe("findGatedLintersForFile", () => {
  test("oxlint fires only when a marker is up-tree from the file", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-gated-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"));
      const file = path.join(tmp, "src", "bad.ts");
      fs.writeFileSync(file, "");
      // no marker anywhere → must not fire
      expect(findGatedLintersForFile(file, tmp)).toHaveLength(0);
      // marker at the tree root → oxlint becomes eligible
      fs.writeFileSync(path.join(tmp, ".oxlintrc.json"), "{}");
      const gated = findGatedLintersForFile(file, tmp);
      if (gated.length > 0) expect(gated[0].name).toBe("oxlint");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  test("enabled override without a marker also unlocks a gated linter", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-gated-"));
    try {
      fs.writeFileSync(path.join(tmp, "bad.ts"), "");
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(path.join(tmp, ".lsp", "servers.json"), JSON.stringify({ enabled: ["oxlint"] }));
      const gated = findGatedLintersForFile(path.join(tmp, "bad.ts"), tmp);
      if (gated.length > 0) expect(gated[0].name).toBe("oxlint");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
  test("disabled suppresses even with an enabled override", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-gated-"));
    try {
      fs.writeFileSync(path.join(tmp, ".oxlintrc.json"), "{}");
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(path.join(tmp, ".lsp", "servers.json"), JSON.stringify({ disabled: ["oxlint"] }));
      expect(findGatedLintersForFile(path.join(tmp, "bad.ts"), tmp)).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
describe("readServerOverrides", () => {
  test("parses enabled + disabled; missing file = both empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-srv-"));
    try {
      const empty = { enabled: new Set<string>(), disabled: new Set<string>() };
      expect(readServerOverrides(tmp)).toEqual(empty);
      fs.mkdirSync(path.join(tmp, ".lsp"));
      fs.writeFileSync(
        path.join(tmp, ".lsp", "servers.json"),
        JSON.stringify({ enabled: ["oxlint"], disabled: ["nixd", "bashls"], ignored: 1 }),
      );
      expect(readServerOverrides(tmp)).toEqual({
        enabled: new Set(["oxlint"]),
        disabled: new Set(["nixd", "bashls"]),
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("configForTsFlavor", () => {
  const base = KNOWN_SERVERS["typescript-language-server"];

  test("ts7 swaps in the native tsc --lsp command, keeping fileTypes/rootMarkers/initOptions", () => {
    const cfg = configForTsFlavor(base, "ts7");
    expect(cfg.command).toBe("tsc");
    expect(cfg.args).toEqual(["--lsp", "--stdio"]);
    expect(cfg.fileTypes).toBe(base.fileTypes);
    expect(cfg.rootMarkers).toBe(base.rootMarkers);
    expect(cfg.initOptions).toBe(base.initOptions);
  });

  test("ts-classic keeps the typescript-language-server wrapper unchanged", () => {
    const cfg = configForTsFlavor(base, "ts-classic");
    expect(cfg).toBe(base);
  });
});

describe("serverDisplayName", () => {
  test("declared displayName wins; unknown keys pass through", () => {
    expect(serverDisplayName("typescript-language-server")).toBe("ts");
    expect(serverDisplayName("lua-language-server")).toBe("lua-ls");
    expect(serverDisplayName("rust-analyzer")).toBe("rust-analyzer");
    expect(serverDisplayName("anything-else")).toBe("anything-else");
  });

  test("configForTsFlavor preserves displayName", () => {
    const cfg = configForTsFlavor(KNOWN_SERVERS["typescript-language-server"], "ts7");
    expect(cfg.displayName).toBe("ts");
  });
});
