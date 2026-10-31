/**
 * LSP client and server resolution.
 *
 * Maps a file to the servers that handle it and starts/stops LSP clients
 * (keyed `serverName::rootPath`, so multiple roots coexist). Also owns the
 * restart operations shared by the `lsp restart` tool action and the
 * `/lsp-restart` command. Pure engine logic — see state.ts for the shared
 * state and index.ts for the harness adapter.
 */

import * as path from "node:path";
import { identifierAt } from "./callers";
import {
  createClient,
  fileToUri,
  findProjectRoot,
  type LspClient,
  openFile,
  resolveCommand,
  syncFile,
  translateLocationUri,
  translateWorkspaceEdit,
  uriToFile,
} from "./client";
import {
  type ContainerTarget,
  detectTsFlavor,
  findDevcontainerRoot,
  readServerContainerConfig,
  resolveServerTarget,
} from "./devcontainer";
import { applyWorkspaceEdit } from "./format";
import { detectLinters } from "./linters";
import { loadPathOverrides, matchPathOverride } from "./overrides";
import {
  configForTsFlavor,
  type DetectedServer,
  detectServers,
  findGatedLintersForFile,
  findServerByExtension,
  KNOWN_SERVERS,
  serversForFile,
} from "./servers";
import { clientKey, type EngineState, TARGET_NULL_TTL_MS } from "./state";
import { updateStatusData, updateStatusDataThrottled } from "./status";

/**
 * Find servers that handle a file — pre-detected first, then a lazy
 * detect-by-extension if none — and start the first one that comes up.
 * Returns the running client + its server, or null when no server serves the
 * file (or none could start).
 */
export async function getClientForFile(
  state: EngineState,
  filePath: string,
): Promise<{ client: LspClient; server: DetectedServer } | null> {
  const abs = path.resolve(filePath);

  // Find servers that handle this file's extension — pre-detected first, then a
  // lazy detect-by-extension if none.
  let servers = getServersForFile(state, abs);
  if (servers.length === 0) {
    const lazyFound = findServerByExtension(abs, state.currentCwd);
    if (lazyFound && !state.detectedServers.some((s) => s.name === lazyFound.name)) {
      state.detectedServers.push(lazyFound);
      updateStatusData(state);
    }
    servers = getServersForFile(state, abs);
    if (servers.length === 0) return null;
  }

  // For each candidate server, resolve the root from the file's markers
  // (`rootForServer`). Rooting at currentCwd is wrong when the server root is a
  // subproject inside (or outside) cwd, e.g. a frontend under a repo root that owns the
  // devcontainer but has no package.json at its own root. The per-server walk-up
  // handles inside-cwd, outside-cwd, and multi-root uniformly.
  for (const server of servers) {
    const client = await getClientAt(state, server.name, rootForServer(state, server, abs));
    if (client) return { client, server };
  }
  return null;
}

/** Start (or reuse) the client for a server at a root. Returns null on
 * start failure — callers treat that as "server unavailable". */
export async function getClientAt(state: EngineState, serverName: string, root: string): Promise<LspClient | null> {
  const key = clientKey(serverName, root);
  const existing = state.clients.get(key);
  if (existing && !existing.dead) return existing;

  // Look up server config
  const config = KNOWN_SERVERS[serverName];
  if (!config) return null;

  // The typescript server's command depends on the workspace's TypeScript
  // flavor: TS ≤6 runs typescript-language-server (spawns lib/tsserver.js);
  // TS7 (native) ships no tsserver.js — its own `tsc --lsp` speaks LSP
  // directly. `.lsp/<server>.json` `_command`/`_args` override the detection.
  // Containers are probed for `tsc` (globally installed alongside the server
  // in managed containers, present for BOTH flavors) so container selection is
  // flavor-independent; the actual spawn command is decided after, when the
  // workspace (which may live only in the container) can be inspected.
  const isTsServer = serverName === "typescript-language-server";
  const lspBase = findDevcontainerRoot(root) ?? root;
  const srv = readServerContainerConfig(lspBase, serverName);
  const probeCommand = srv.command ?? (isTsServer ? "tsc" : config.command);

  // Resolve a devcontainer target (null = host mode). Cached per session.
  let target: ContainerTarget | null = null;
  const cached = state.targetCache.get(key);
  if (cached && (cached.target !== null || cached.expires > Date.now())) {
    target = cached.target;
  } else {
    try {
      target = await resolveServerTarget(root, serverName, probeCommand, undefined, (msg) => {
        state.host.notify(msg, "warning");
      });
    } catch {
      target = null;
    }
    state.targetCache.set(key, { target, expires: Date.now() + TARGET_NULL_TTL_MS });
  }

  // Effective spawn config: explicit `_command`/`_args` win; else auto-detect
  // the TypeScript flavor (container probe or host fs) and pick the command.
  let effective = config;
  if (srv.command) {
    effective = { ...config, command: srv.command, args: srv.args ?? [] };
  } else if (isTsServer) {
    const flavor = await detectTsFlavor(root, target);
    effective = configForTsFlavor(config, flavor);
  }

  try {
    let client: LspClient;
    client = await createClient(serverName, effective, root, target, {
      // Command-only actions (move-to-file et al.) have the server push the edit
      // back via inbound workspace/applyEdit; apply it and record what landed so
      // codeActionApply can report it (the executeCommand result itself is void).
      onApplyEdit: async (edit) => {
        const { applied } = await applyWorkspaceEdit(translateWorkspaceEdit(edit, client.pathMap), root, (editPath) => {
          syncFile(client, editPath);
        });
        state.lastServerAppliedPaths = applied.map((r) => r.path);
        return applied.length > 0;
      },
      // tls follows applyEdit with an inbound `_typescript.rename` refresh: rename
      // the symbol at the given location to itself (a no-op on content) so the
      // server's rename pipeline settles.
      onRename: async (params) => {
        try {
          const hostFile = uriToFile(translateLocationUri(params.textDocument.uri, client.pathMap));
          const name = identifierAt(hostFile, params.position);
          if (!name) return null;
          return await client.request("textDocument/rename", {
            textDocument: params.textDocument,
            position: params.position,
            newName: name,
          });
        } catch {
          return null; // best-effort refresh; the refactor edits already landed
        }
      },
    });
    client.onProgress = () => updateStatusDataThrottled(state);
    state.clients.set(key, client);
    return client;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lsp] Failed to start ${serverName} at ${root}: ${msg}`);
    return null;
  }
}

/** Client for a server at the session cwd. */
export async function getClient(state: EngineState, serverName: string): Promise<LspClient | null> {
  return getClientAt(state, serverName, state.currentCwd);
}

/**
 * All servers that handle a file: detected + per-repo path overrides
 * (.lsp/config.json `paths`) + repo-gated linters with a config marker
 * up-tree (oxlint, biome).
 */
export function getServersForFile(state: EngineState, filePath: string): DetectedServer[] {
  const base = serversForFile(filePath, state.detectedServers);
  // Per-repo path overrides (.lsp/config.json `paths`): a glob may map a file
  // to a server its name hides (e.g. generated text holding SQL).
  const override = matchPathOverride(filePath, loadPathOverrides(state.currentCwd));
  let result: DetectedServer[];
  if (override) {
    const existing = state.detectedServers.find((s) => s.name === override);
    if (existing) {
      result = base.includes(existing) ? base : [...base, existing];
    } else {
      const config = KNOWN_SERVERS[override];
      const resolved = config ? resolveCommand(config.command, state.currentCwd) : null;
      if (!resolved) return base;
      const ds: DetectedServer = { name: override, config, resolvedCommand: resolved };
      state.detectedServers.push(ds);
      result = [...base, ds];
    }
  } else {
    result = base;
  }
  return appendGatedLinters(state, filePath, result);
}

/**
 * Repo-gated linters (oxlint, biome) serve any file whose tree carries
 * their config marker (or an `enabled` override), even when the session started
 * in a different directory. Detect on first touch and cache in detectedServers
 * so later calls are stable.
 */
function appendGatedLinters(state: EngineState, filePath: string, base: DetectedServer[]): DetectedServer[] {
  let result = base;
  for (const ds of findGatedLintersForFile(filePath, state.currentCwd)) {
    if (state.detectedServers.some((s) => s.name === ds.name)) continue;
    state.detectedServers.push(ds);
    result = [...result, ds];
  }
  return result;
}

/**
 * Read-time warming: when the agent `read`s a code file, open it in its LSP
 * server in the background (didOpen) so the first interactive call
 * (symbols/hover/incoming) is warm instead of paying cold-parse latency.
 * Fire-and-forget — never blocks the read.
 *
 * Gated to pre-detected servers only: a `read` never triggers lazy discovery
 * (that stays an `lsp` tool concern). The server itself starts on demand if
 * not already running, matching session-start warming.
 */
export async function warmRead(state: EngineState, abs: string): Promise<void> {
  const servers = getServersForFile(state, abs);
  if (servers.length === 0) return;
  for (const server of servers) {
    const client = await getClientAt(state, server.name, rootForServer(state, server, abs));
    if (client) {
      await openFile(client, abs);
      return;
    }
  }
}

/**
 * Resolve the server root for a file, applying the server's `rootStrategy` (the rules are in
 * `findProjectRoot`), falling back to currentCwd. This is what roots a subproject file at the
 * subproject rather than at cwd.
 */
export function rootForServer(state: EngineState, server: DetectedServer, absFile: string): string {
  return findProjectRoot(absFile, server.config.rootMarkers, server.config.rootStrategy) ?? state.currentCwd;
}

/** Check if any active LSP client has this file open (i.e., it's not new to the LSP). */
export function isFileOpenInAnyClient(state: EngineState, filePath: string, cwd: string): boolean {
  const abs = path.resolve(cwd, filePath);
  const uri = fileToUri(abs);
  for (const client of state.clients.values()) {
    if (!client.dead && client.openFiles.has(uri)) return true;
  }
  return false;
}

/** Shut down all clients and clear the target cache. */
export async function shutdownAll(state: EngineState): Promise<void> {
  const shutdowns = Array.from(state.clients.values()).map((c) => c.shutdown());
  await Promise.allSettled(shutdowns);
  state.clients.clear();
  state.targetCache.clear();
}

/**
 * lsp tool `restart` without a file: shut down all clients and re-warm
 * current detected servers (no re-detect). Returns the report text.
 */
export async function restartAllClients(state: EngineState): Promise<string> {
  const names = [...state.clients.values()].map((c) => c.name);
  await shutdownAll(state);

  // Re-warm session cwd servers
  for (const server of state.detectedServers) {
    try {
      await getClient(state, server.name);
    } catch {
      // Non-fatal
    }
  }
  updateStatusData(state);
  return `Restarted ${names.length} server(s): ${names.join(", ") || "none"}`;
}

/**
 * `/lsp-restart` command: shut down, re-detect servers/linters at cwd,
 * re-warm. Returns the combined server+linter names for the caller to report.
 */
export async function restartWithRedetect(state: EngineState, cwd: string): Promise<string[]> {
  await shutdownAll(state);
  state.detectedServers = detectServers(cwd);
  state.detectedLinters = detectLinters(cwd);
  // Re-warm LSP servers
  for (const server of state.detectedServers) {
    try {
      await getClient(state, server.name);
    } catch {
      // Non-fatal
    }
  }
  const names = [...state.detectedServers.map((s) => s.name), ...state.detectedLinters.map((l) => l.name)];
  updateStatusData(state);
  return names;
}
