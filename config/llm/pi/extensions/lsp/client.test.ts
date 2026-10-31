import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Diagnostic, diagnosticsFromPullReport, findProjectRoot, type RootMarker } from "./client";
import { rootForServer } from "./client-mgmt";
import type { DetectedServer } from "./servers";
import type { EngineState } from "./state";

/** The typescript server's tiers: a project file first, a package manifest second. */
const TIERS: RootMarker[] = [["tsconfig.json", "jsconfig.json"], "package.json"];

describe("findProjectRoot", () => {
  test("finds root with Cargo.toml marker", () => {
    // We know the system repo has a flake.nix
    const result = findProjectRoot(import.meta.path, ["flake.nix"]);
    // Should find some ancestor with flake.nix (or null if none)
    // The test file lives in the lsp extension dir which is under the system repo
    if (result) {
      expect(fs.existsSync(path.join(result, "flake.nix"))).toBe(true);
    }
  });

  test("returns null when no markers found", () => {
    // Use a path deep in /tmp where no Cargo.toml exists
    const result = findProjectRoot("/tmp/nonexistent/deep/file.ts", ["Cargo.toml"]);
    expect(result).toBeNull();
  });

  test("finds nearest root with marker", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const nested = path.join(tmpRoot, "a", "b", "c");
    fs.mkdirSync(nested, { recursive: true });
    // Place marker at tmpRoot/a/
    fs.writeFileSync(path.join(tmpRoot, "a", "Cargo.toml"), "");
    // Place marker at tmpRoot/ too (should NOT be returned since a/ is nearer)
    fs.writeFileSync(path.join(tmpRoot, "Cargo.toml"), "");

    const testFile = path.join(nested, "main.rs");
    fs.writeFileSync(testFile, "");

    const result = findProjectRoot(testFile, ["Cargo.toml"]);
    expect(result).toBe(path.join(tmpRoot, "a"));

    // Cleanup
    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("checks multiple markers", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const nested = path.join(tmpRoot, "src");
    fs.mkdirSync(nested, { recursive: true });
    // Place a package.json marker
    fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}");

    const testFile = path.join(nested, "index.ts");
    fs.writeFileSync(testFile, "");

    // Should find root via package.json
    const result = findProjectRoot(testFile, ["package.json", "tsconfig.json"]);
    expect(result).toBe(tmpRoot);

    // Should NOT find root if looking for wrong markers
    const noResult = findProjectRoot(testFile, ["Cargo.toml", "go.mod"]);
    expect(noResult).toBeNull();

    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("the default strategy takes the nearest marker", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const packageDir = path.join(tmpRoot, "packages", "acme");
    const srcDir = path.join(packageDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
    const testFile = path.join(srcDir, "index.ts");
    fs.writeFileSync(testFile, "");

    expect(findProjectRoot(testFile, TIERS)).toBe(packageDir);

    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("the markers strategy lets a project file outrank a nearer marker", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const packageDir = path.join(tmpRoot, "packages", "acme");
    const srcDir = path.join(packageDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
    const testFile = path.join(srcDir, "index.ts");
    fs.writeFileSync(testFile, "");

    expect(findProjectRoot(testFile, TIERS, "markers")).toBe(tmpRoot);

    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("a tier holds equivalent markers, so a nearer jsconfig beats a farther tsconfig", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const jsDir = path.join(tmpRoot, "packages", "ui");
    fs.mkdirSync(path.join(jsDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(jsDir, "jsconfig.json"), "{}");
    const testFile = path.join(jsDir, "src", "app.js");
    fs.writeFileSync(testFile, "");

    expect(findProjectRoot(testFile, TIERS, "markers")).toBe(jsDir);

    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("the markers walk stops at the checkout", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const repo = path.join(outside, "acme");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(outside, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(repo, "package.json"), "{}");
    const testFile = path.join(repo, "src", "index.ts");
    fs.writeFileSync(testFile, "");

    expect(findProjectRoot(testFile, TIERS, "markers")).toBe(repo);

    fs.rmSync(outside, { recursive: true });
  });

  test("the default strategy walks past the checkout", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const repo = path.join(outside, "acme");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(outside, "tsconfig.json"), "{}");
    const testFile = path.join(repo, "src", "index.ts");
    fs.writeFileSync(testFile, "");

    expect(findProjectRoot(testFile, TIERS)).toBe(outside);

    fs.rmSync(outside, { recursive: true });
  });

  test("outside a repository the walk still reaches a marker above the file", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    fs.mkdirSync(path.join(tmpRoot, "acme", "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "tsconfig.json"), "{}");
    const testFile = path.join(tmpRoot, "acme", "src", "index.ts");
    fs.writeFileSync(testFile, "");

    expect(findProjectRoot(testFile, TIERS, "markers")).toBe(tmpRoot);

    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("falls through to the weaker marker when no project file exists above it", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const packageDir = path.join(tmpRoot, "packages", "acme");
    fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
    const testFile = path.join(packageDir, "src", "index.ts");
    fs.writeFileSync(testFile, "");

    expect(findProjectRoot(testFile, TIERS, "markers")).toBe(packageDir);

    fs.rmSync(tmpRoot, { recursive: true });
  });

  test("handles file at root marker directory itself", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    fs.writeFileSync(path.join(tmpRoot, "Cargo.toml"), "");

    const testFile = path.join(tmpRoot, "main.rs");
    fs.writeFileSync(testFile, "");

    const result = findProjectRoot(testFile, ["Cargo.toml"]);
    expect(result).toBe(tmpRoot);

    fs.rmSync(tmpRoot, { recursive: true });
  });
});

describe("rootForServer", () => {
  test("passes the server's strategy through to the walk", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
    const packageDir = path.join(tmpRoot, "packages", "acme");
    fs.mkdirSync(path.join(packageDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "tsconfig.json"), "{}");
    fs.writeFileSync(path.join(packageDir, "package.json"), "{}");
    const testFile = path.join(packageDir, "src", "index.ts");
    fs.writeFileSync(testFile, "");
    const state = { currentCwd: tmpRoot } as unknown as EngineState;
    const server = {
      name: "ts",
      resolvedCommand: "tsc",
      config: {
        command: "tsc",
        fileTypes: [".ts"],
        rootMarkers: TIERS,
        rootStrategy: "markers",
      },
    } as unknown as DetectedServer;

    expect(rootForServer(state, server, testFile)).toBe(tmpRoot);
    expect(rootForServer(state, { ...server, config: { ...server.config, rootStrategy: undefined } }, testFile)).toBe(
      packageDir,
    );

    fs.rmSync(tmpRoot, { recursive: true });
  });
});

describe("diagnosticsFromPullReport", () => {
  const diag = (msg: string): Diagnostic => ({
    message: msg,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  });

  test("full report returns its items", () => {
    const items = [diag("a"), diag("b")];
    expect(diagnosticsFromPullReport({ kind: "full", items })).toEqual(items);
  });

  test("unchanged report returns null (keep current diagnostics)", () => {
    expect(diagnosticsFromPullReport({ kind: "unchanged", resultId: "x" })).toBeNull();
  });

  test("malformed payloads return null", () => {
    expect(diagnosticsFromPullReport(null)).toBeNull();
    expect(diagnosticsFromPullReport("nope")).toBeNull();
    expect(diagnosticsFromPullReport({ items: "not-an-array" })).toBeNull();
  });

  test("non-diagnostic items are filtered out", () => {
    const items = [diag("ok"), { nope: true }, null];
    expect(diagnosticsFromPullReport({ kind: "full", items })).toEqual([diag("ok")]);
  });
});
