/**
 * LSP server configurations and auto-detection.
 *
 * Server configs adapted from oh-my-pi's defaults.json.
 * Auto-detection: checks root markers in cwd, then verifies binary is on PATH.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerConfig } from "./client";
import { findProjectRoot, hasRootMarkers, resolveCommand } from "./client";
import type { TsFlavor } from "./devcontainer";
import { findDevcontainerRoot } from "./devcontainer";

/** Calculate tsserver memory limit: 1/8 of system RAM, min 4096 MB */
export function getTsServerMemory(): number {
  const systemMB = Math.floor(os.totalmem() / (1024 * 1024));
  return Math.max(4096, Math.floor(systemMB / 8));
}

/**
 * Known LSP server configurations.
 * Key = server name, value = how to start it and what files it handles.
 */
export const KNOWN_SERVERS: Record<string, ServerConfig> = {
  "typescript-language-server": {
    command: "typescript-language-server",
    displayName: "ts",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: [["tsconfig.json", "jsconfig.json"], "package.json"],
    // tsserver reads `paths` from the tsconfig at its root, so with a tsconfig above it, a
    // directory holding only a `package.json` gives tsserver an inferred project without
    // those paths.
    rootStrategy: "markers",
    initOptions: {
      hostInfo: "pi-lsp-extension",
      maxTsServerMemory: getTsServerMemory(),
      preferences: {
        includeInlayParameterNameHints: "all",
        includeInlayVariableTypeHints: true,
      },
    },
  },

  // JS/TS linter over the LSP protocol. Overlaps the typescript server's
  // fileTypes but is complementary: tsserver reports type errors, oxlint
  // reports style/correctness (unused vars, no-debugger, floating promises
  // with --type-aware). Repo-gated on oxlint's config file — a project only
  // opts in to oxlint by shipping one, so it never lints a repo that doesn't
  // use it (disable via .lsp/servers.json `disabled` too).
  oxlint: {
    command: "oxlint",
    displayName: "oxlint",
    args: ["--lsp"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: [".oxlintrc.json", ".oxlintrc.jsonc", "oxlint.config.ts", "oxlint.config.mts"],
    allowLazy: false,
  },

  biome: {
    command: "biome",
    displayName: "biome",
    args: ["lsp-proxy"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"],
    rootMarkers: ["biome.json", "biome.jsonc"],
    allowLazy: false,
  },

  "rust-analyzer": {
    command: "rust-analyzer",
    args: [],
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", "rust-analyzer.toml"],
    // Disable hover actions (implementations, references, debug) — the agent
    // doesn't use interactive hover UI, and these cause timeouts on complex types.
    // Keep hover content (type info + docs) but skip the action buttons.
    initOptions: {
      hover: {
        actions: { enable: false },
        // Disable memory layout info — not useful for an agent, adds computation
        memoryLayout: { enable: false },
      },
    },
  },

  gopls: {
    command: "gopls",
    args: ["serve"],
    fileTypes: [".go"],
    rootMarkers: ["go.mod", "go.work"],
    settings: {
      gopls: {
        analyses: { unusedparams: true, shadow: true },
        staticcheck: true,
      },
    },
  },

  pyright: {
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "requirements.txt"],
    settings: {
      python: {
        analysis: {
          autoSearchPaths: true,
          diagnosticMode: "openFilesOnly",
          useLibraryCodeForTypes: true,
        },
      },
    },
  },

  nixd: {
    command: "nixd",
    args: [],
    fileTypes: [".nix"],
    rootMarkers: ["flake.nix", "default.nix", "shell.nix"],
  },

  "lua-language-server": {
    command: "lua-language-server",
    displayName: "lua-ls",
    args: [],
    fileTypes: [".lua"],
    languageId: "lua",
    rootMarkers: [".luarc.json", ".luarc.jsonc", ".stylua.toml"],
    settings: {
      Lua: {
        runtime: { version: "LuaJIT" },
        diagnostics: { globals: ["vim"] },
        workspace: { checkThirdParty: false },
        telemetry: { enable: false },
      },
    },
  },

  bashls: {
    command: "bash-language-server",
    args: ["start"],
    fileTypes: [".sh", ".bash", ".zsh"],
    rootMarkers: [".git"],
    settings: {
      bashIde: {
        globPattern: "*@(.sh|.inc|.bash|.command)",
        diagnosticsIgnorePatterns: ["**/node_modules"],
      },
    },
  },

  yamlls: {
    command: "yaml-language-server",
    args: ["--stdio"],
    fileTypes: [".yaml", ".yml"],
    rootMarkers: [".git"],
    settings: {
      yaml: {
        validate: true,
        format: { enable: true },
        hover: true,
        completion: true,
        schemaStore: { enable: false },
      },
      redhat: { telemetry: { enabled: false } },
    },
  },

  taplo: {
    command: "taplo",
    args: ["lsp", "stdio"],
    fileTypes: [".toml"],
    languageId: "toml",
    rootMarkers: [".taplo.toml", "taplo.toml", ".git"],
  },

  marksman: {
    command: "marksman",
    args: ["server"],
    fileTypes: [".md", ".markdown"],
    languageId: "markdown",
    rootMarkers: [".marksman.toml", ".git"],
  },

  "roslyn-ls": {
    command: "Microsoft.CodeAnalysis.LanguageServer",
    args: ["--stdio", "--autoLoadProjects"],
    fileTypes: [".cs"],
    languageId: "csharp",
    rootMarkers: [".sln", "*.csproj"],
    startupTimeoutMs: 30_000,
  },

  css: {
    command: "vscode-css-language-server",
    args: ["--stdio"],
    fileTypes: [".css", ".scss", ".less"],
    rootMarkers: [".git"],
  },

  dockerfile: {
    command: "docker-langserver",
    args: ["--stdio"],
    fileTypes: ["Dockerfile", ".dockerfile"],
    languageId: "dockerfile",
    rootMarkers: ["Dockerfile"],
  },

  html: {
    command: "vscode-html-language-server",
    args: ["--stdio"],
    fileTypes: [".html", ".htm"],
    languageId: "html",
    rootMarkers: [".git"],
  },

  jdtls: {
    command: "jdtls",
    args: ["-data", "$HOME/.cache/jdtls-workspace"],
    fileTypes: [".java"],
    languageId: "java",
    rootMarkers: ["pom.xml", "build.gradle", "settings.gradle"],
    startupTimeoutMs: 90_000,
  },

  json: {
    command: "vscode-json-language-server",
    args: ["--stdio"],
    fileTypes: [".json", ".jsonc"],
    languageId: "json",
    rootMarkers: [".git"],
  },

  lemminx: {
    command: "lemminx",
    args: [],
    fileTypes: [".xml", ".xsd", ".xsl"],
    languageId: "xml",
    rootMarkers: [".git"],
  },

  powershell: {
    command: "powershell-editor-services",
    args: ["-Stdio"],
    fileTypes: [".ps1", ".psm1", ".psd1"],
    languageId: "powershell",
    rootMarkers: [".git"],
    startupTimeoutMs: 30_000,
    // PowerShellEditorServices writes session state into its cwd — keep it
    // out of the project root.
    cwd: "$HOME/.cache/pwsh-lsp",
  },

  clangd: {
    command: "clangd",
    args: ["--background-index", "--clang-tidy"],
    fileTypes: [".c", ".cpp", ".cc", ".h", ".hpp"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd"],
  },

  zls: {
    command: "zls",
    args: [],
    fileTypes: [".zig"],
    languageId: "zig",
    rootMarkers: ["build.zig", "build.zig.zon"],
  },

  "sourcekit-lsp": {
    command: "sourcekit-lsp",
    args: [],
    fileTypes: [".swift"],
    rootMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"],
  },

  "slint-lsp": {
    command: "slint-lsp",
    args: [],
    fileTypes: [".slint"],
    rootMarkers: ["Cargo.toml", ".slint"],
  },
};

/**
 * TS7 (native) ships its own LSP: `tsc --lsp --stdio`. No Node wrapper needed.
 * The native server ignores the classic initOptions (maxTsServerMemory,
 * preferences) — verified harmless. Code actions verified live against tsgo
 * 7.0.2: quickfixes (e.g. "Add import") work but ONLY when diagnostics are
 * passed in context.diagnostics (see requestCodeActions); import source
 * actions (organize/removeUnused/sort) work; type-error quickfixes, fixAll
 * and refactor are not implemented upstream (typescript-go#4005: TS7 won't
 * reimplement 100% of classic actions).
 */
export const TS7_COMMAND = "tsc";
export const TS7_ARGS = ["--lsp", "--stdio"];

/** Effective TS server config for the detected flavor. TS ≤6 keeps the classic wrapper. */
export function configForTsFlavor(config: ServerConfig, flavor: TsFlavor): ServerConfig {
  return flavor === "ts7" ? { ...config, command: TS7_COMMAND, args: TS7_ARGS } : config;
}

/** Display name for a server key — `displayName` when declared, else the key itself. */
export function serverDisplayName(name: string): string {
  return KNOWN_SERVERS[name]?.displayName ?? name;
}

export interface DetectedServer {
  name: string;
  config: ServerConfig;
  resolvedCommand: string;
}

/**
 * Read `.lsp/servers.json` `{ "enabled": [...], "disabled": [...] }` from the devcontainer
 * root (git root) when present, else cwd. Same `.lsp/` convention as linters.json.
 * `enabled` forces a server without a marker; `disabled` always suppresses.
 */
export interface ServerOverrides {
  /** Force-run these servers even without a root marker present. */
  enabled: Set<string>;
  /** Suppress these servers even when a root marker IS present. */
  disabled: Set<string>;
}

/**
 * Read `.lsp/servers.json` (`{ "enabled": [...], "disabled": [...] }`) from the
 * devcontainer root (git root) when present, else cwd. Same `.lsp/` location
 * convention as servers. Returns empty sets when absent or unparseable.
 */
export function readServerOverrides(cwd: string): ServerOverrides {
  const base = findDevcontainerRoot(cwd) ?? cwd;
  const asSet = (v: unknown): Set<string> =>
    Array.isArray(v) ? new Set(v.filter((n): n is string => typeof n === "string")) : new Set<string>();
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(base, ".lsp", "servers.json"), "utf-8")) as {
      enabled?: unknown;
      disabled?: unknown;
    };
    return { enabled: asSet(parsed.enabled), disabled: asSet(parsed.disabled) };
  } catch {
    // no file or parse error
  }
  return { enabled: new Set(), disabled: new Set() };
}

/**
 * Decide whether a server should run, applying `.lsp/servers.json` overrides on
 * top of the default marker gate: `disabled` wins, then `enabled`, else the
 * marker presence decides. Mirrors the linters gate.
 */
function isServerWanted(name: string, cwd: string, hasMarker: boolean): boolean {
  const { enabled, disabled } = readServerOverrides(cwd);
  if (disabled.has(name)) return false;
  if (enabled.has(name)) return true;
  return hasMarker;
}

/**
 * Detect which LSP servers are available for a given directory.
 * Checks root markers first, then verifies the binary exists.
 */
export function detectServers(cwd: string): DetectedServer[] {
  const detected: DetectedServer[] = [];

  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
    const hasMarker = hasRootMarkers(cwd, config.rootMarkers);
    if (!isServerWanted(name, cwd, hasMarker)) continue;

    // Check if binary exists
    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    detected.push({ name, config, resolvedCommand: resolved });
  }

  return detected;
}

/**
 * Find servers that handle a given file extension.
 */
export function serversForFile(filePath: string, detected: DetectedServer[]): DetectedServer[] {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  return detected.filter((s) => s.config.fileTypes.includes(ext) || (ext === "" && s.config.fileTypes.includes(base)));
}

/**
 * Find a known server for a file extension, ignoring root markers.
 * Used for lazy startup when a file is touched that no detected server handles.
 * Returns null if no server binary is available.
 */
export function findServerByExtension(filePath: string, cwd: string): DetectedServer | null {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  const { enabled, disabled } = readServerOverrides(cwd);

  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
    const matches = config.fileTypes.includes(ext) || (ext === "" && config.fileTypes.includes(base));
    if (!matches) continue;
    if (disabled.has(name)) continue;
    if (config.allowLazy === false) {
      // Repo-gated linter: only lazy-start when opted in — an `enabled` override,
      // or a config marker present up-tree from the file. The marker walk keeps
      // it from firing in random directories while still covering subprojects.
      const hasRoot = findProjectRoot(filePath, config.rootMarkers) !== null;
      if (!enabled.has(name) && !hasRoot) continue;
    }

    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    return { name, config, resolvedCommand: resolved };
  }

  return null;
}

/**
 * Gated providers (`allowLazy: false`, repo-gated linters like oxlint) that
 * should serve a specific file: those with an `enabled` override, or a config
 * marker present up-tree from the file. Unlike `findServerByExtension` (the
 * single-server lazy fallback), this returns ALL matches so a gated linter can
 * join the diagnostic pipeline alongside a code-intel server already serving
 * the same extension (e.g. oxlint next to the TypeScript server on a .ts).
 */
export function findGatedLintersForFile(filePath: string, cwd: string): DetectedServer[] {
  const { enabled, disabled } = readServerOverrides(cwd);
  const result: DetectedServer[] = [];

  for (const [name, config] of Object.entries(KNOWN_SERVERS)) {
    if (config.allowLazy !== false) continue;
    if (disabled.has(name)) continue;
    const hasRoot = findProjectRoot(filePath, config.rootMarkers) !== null;
    if (!enabled.has(name) && !hasRoot) continue;

    const resolved = resolveCommand(config.command, cwd);
    if (!resolved) continue;

    result.push({ name, config, resolvedCommand: resolved });
  }

  return result;
}
