/**
 * LSP JSON-RPC client over stdio.
 *
 * Spawns a language server process, speaks JSON-RPC 2.0 over stdin/stdout.
 * Handles initialization, text document sync, and request/response routing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { deepMerge } from "../shared/deep-merge";
import { type ContainerTarget, findDevcontainerRoot, type PathMap, pathFromServer, pathToServer } from "./devcontainer";

// ── Types ──

/** Glob pattern registered by a server for file watching */
export interface RegisteredWatcher {
  globPattern: string;
  /** Bitmask: 1=Create, 2=Change, 4=Delete. Default 7 (all). */
  kind: number;
}

/** Progress state for a work done token */
export interface WorkDoneProgress {
  /** Token identifying this progress */
  token: string | number;
  /** Current state */
  state: "started" | "reporting" | "done";
  /** Progress title (from 'begin') */
  title: string;
  /** Optional status message */
  message?: string;
  /** Optional percentage 0-100 */
  percentage?: number;
  /** Timestamp of last update (ms since epoch) */
  lastUpdated: number;
}

export interface LspClient {
  /** Server process */
  proc: ChildProcess;
  /** Server name (for logging) */
  name: string;
  /** LSP languageId for this server's files; preferred over detectLanguageId's map when set. */
  languageId?: string;
  /** Effective spawn command (command + args, e.g. "tsc --lsp --stdio") — may differ from the server key's default when flavor detection or `_command` overrides picked another binary. */
  command: string;
  /** Host↔container path map (null = host-local server, no translation). */
  pathMap: PathMap | null;
  /** Container name when running in a devcontainer (null/undefined = host). */
  containerName?: string;
  /** Resolved server capabilities from initialize response */
  capabilities: ServerCapabilities;
  /** Currently open files (URI -> version) */
  openFiles: Map<string, number>;
  /** Latest diagnostics per URI */
  diagnostics: Map<string, Diagnostic[]>;
  /** Monotonic version counter for diagnostics (increments on any publish) */
  diagnosticsVersion: number;
  /** True when the server advertises pull diagnostics — the client polls after edits. */
  pullDiagnostics: boolean;
  /** Glob patterns registered by the server via client/registerCapability */
  registeredWatchers: RegisteredWatcher[];
  /** Active work done progress tokens */
  progress: Map<string | number, WorkDoneProgress>;
  /** Callback invoked when progress state changes */
  onProgress: ((progress: WorkDoneProgress) => void) | undefined;
  /** Send a JSON-RPC request and wait for response */
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  /** Send a JSON-RPC notification (no response expected) */
  notify: (method: string, params?: unknown) => void;
  /** Shut down gracefully */
  shutdown: () => Promise<void>;
  /** Whether the client has been shut down */
  dead: boolean;
  /** When this client was created (ms since epoch) */
  createdAt: number;
}

export interface ServerCapabilities {
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | { includeText?: boolean } };
  completionProvider?: unknown;
  hoverProvider?: boolean | object;
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  workspaceSymbolProvider?: boolean | object;
  callHierarchyProvider?: boolean | object;
  codeActionProvider?: boolean | object;
  documentFormattingProvider?: boolean | object;
  renameProvider?: boolean | object;
  /**
   * Pull-diagnostics support (`textDocument/diagnostic`). Servers that
   * advertise this (e.g. the TS7 native LSP) may never push
   * `textDocument/publishDiagnostics` for source files — the client must ask.
   */
  diagnosticProvider?: { identifier?: string; interFileDependencies?: boolean } | boolean;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  originSelectionRange?: Range;
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
}

export interface Diagnostic {
  range: Range;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  code?: number | string;
  source?: string;
  message: string;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version: number | null };
  edits: TextEdit[];
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<TextDocumentEdit | CreateFile | RenameFile | DeleteFile>;
}

/** LSP resource operations — executed by applyWorkspaceEdit. */
export interface CreateFile {
  kind: "create";
  uri: string;
}
export interface RenameFile {
  kind: "rename";
  oldUri: string;
  newUri: string;
}
export interface DeleteFile {
  kind: "delete";
  uri: string;
}

export interface Hover {
  contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>;
  range?: Range;
}

export interface CodeAction {
  title: string;
  kind?: string;
  diagnostics?: Diagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string; reasonCode?: string };
  command?: { title: string; command: string; arguments?: unknown[] };
  edit?: WorkspaceEdit;
  editRange?: { range: Range; replacementText: string };
  data?: unknown;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

/** LSP `textDocument/prepareCallHierarchy` item (a symbol usable as a call-hierarchy root). */
export interface CallHierarchyItem {
  name: string;
  kind: number;
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

/** `callHierarchy/incomingCalls` result: one caller symbol plus the call sites. */
export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

/** `callHierarchy/outgoingCalls` result: one callee symbol plus the call sites. */
export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

// ── JSON-RPC transport ──

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function createTransport(proc: ChildProcess) {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  // Frame parsing operates on BYTES: Content-Length counts bytes, and JSON
  // bodies may contain multi-byte UTF-8 (e.g. the TS7 native server's markdown
  // hovers). Accumulating as a string and slicing by Content-Length desyncs
  // the framing on any non-ASCII message — decode only the fully-sliced body.
  let buffer = Buffer.alloc(0);
  let contentLength = -1;
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const requestHandlers = new Map<string, (params: unknown) => unknown>();

  const stdout = proc.stdout;
  if (!stdout) throw new Error("LSP process has no stdout");
  stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (contentLength === -1) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const header = buffer.subarray(0, headerEnd).toString("latin1"); // headers are ASCII
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        contentLength = parseInt(match[1], 10);
        buffer = buffer.subarray(headerEnd + 4);
      }

      if (buffer.length < contentLength) break;

      const body = buffer.subarray(0, contentLength).toString("utf-8");
      buffer = buffer.subarray(contentLength);
      contentLength = -1;

      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        if (msg.id !== undefined && !msg.method) {
          // Response to our request
          const req = pending.get(msg.id);
          if (req) {
            pending.delete(msg.id);
            if (msg.error) {
              req.reject(new Error(`LSP error: ${msg.error.message} (${msg.error.code})`));
            } else {
              req.resolve(msg.result);
            }
          }
        } else if (msg.method && msg.id !== undefined) {
          // Server-to-client request (needs response). Handlers may be async;
          // resolve them before replying so inbound workspace/applyEdit and
          // typescript/rename complete before the server proceeds.
          const reqHandler = requestHandlers.get(msg.method);
          if (reqHandler) {
            Promise.resolve()
              .then(() => reqHandler(msg.params))
              .then((result) => send({ jsonrpc: "2.0", id: msg.id, result: result ?? null }))
              .catch((e) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } }));
          } else {
            // Name the method: a generic "Method not found" here is always
            // OUR gap (a server request we don't serve), which is otherwise
            // indistinguishable from a server-side failure.
            send({
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: `Unhandled inbound request: ${msg.method}` },
            });
          }
        } else if (msg.method) {
          // Server-to-client notification (no response)
          const handler = notificationHandlers.get(msg.method);
          if (handler) handler(msg.params);
        }
      } catch {
        // Ignore parse errors
      }
    }
  });

  function send(msg: object) {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    const stdin = proc.stdin;
    if (!stdin) throw new Error("LSP process has no stdin");
    stdin.write(header + body);
  }

  function request(method: string, params?: unknown, timeoutMs: number = LSP_REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`LSP request timed out: ${method} (${timeoutMs / 1000}s)`));
      }, timeoutMs);

      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method: string, params?: unknown) {
    send({ jsonrpc: "2.0", method, params });
  }

  function onNotification(method: string, handler: (params: unknown) => void) {
    notificationHandlers.set(method, handler);
  }

  function onRequest(method: string, handler: (params: unknown) => unknown) {
    requestHandlers.set(method, handler);
  }

  function cleanup() {
    for (const [, req] of pending) {
      req.reject(new Error("LSP client shut down"));
    }
    pending.clear();
  }

  return { request, notify, onNotification, onRequest, cleanup };
}

// ── Client lifecycle ──

/**
 * Per-request timeout for LSP calls (ms). When a request exceeds this the
 * client rejects with "LSP request timed out: <method> (Ns)"; callers decide
 * whether to surface that as an error or treat it as a cold-server signal
 * (e.g. the symbols action retries immediately and marks the server cold).
 */
export const LSP_REQUEST_TIMEOUT_MS = 10_000;

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: {
      didSave: true,
      dynamicRegistration: false,
      willSave: false,
      willSaveWaitUntil: false,
    },
    hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    typeDefinition: { dynamicRegistration: false, linkSupport: true },
    implementation: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: {
      dynamicRegistration: false,
      hierarchicalDocumentSymbolSupport: true,
      symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) },
    },
    codeAction: { dynamicRegistration: false },
    formatting: { dynamicRegistration: false },
    rename: { dynamicRegistration: false, prepareSupport: true },
    publishDiagnostics: { relatedInformation: true },
    diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
  },
  window: {
    workDoneProgress: true,
  },
  workspace: {
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
    symbol: { dynamicRegistration: false },
  },
};

export type RootStrategy = "nearest" | "markers";

/** A marker name or glob, or several of them that mark the same kind of project. */
export type RootMarker = string | string[];

export interface ServerConfig {
  command: string;
  args?: string[];
  fileTypes: string[];
  /**
   * Marker names; an array entry is one tier of equivalent markers, which only matters under
   * `rootStrategy: "markers"`. See `findProjectRoot`.
   */
  rootMarkers: RootMarker[];
  /**
   * How to pick the root: `nearest` (default) or `markers`. See `findProjectRoot`.
   */
  rootStrategy?: RootStrategy;
  /** Short name for status/footer/diagnostic-header rendering. Keys stay canonical (`.lsp/<key>.json` discovery). */
  displayName?: string;
  /**
   * Whether findServerByExtension may start this server on touch, without a
   * root marker. Default true — code-intel servers intentionally lazy-start
   * in marker-less dirs (scratch files). Mark false for repo-gated providers
   * (linters like oxlint) so they only run when a config opts them in.
   */
  allowLazy?: boolean;
  /**
   * LSP languageId for this server's files. Preferred over the extension map
   * in detectLanguageId when set — declare it for single-language servers so
   * a new server doesn't need a map entry. Multi-language servers (ts, css)
   * rely on the map (one server, several languageIds).
   */
  languageId?: string;
  initOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /**
   * Grace period for the initialize request (ms). Some servers are slow to
   * boot (JVM/.NET/scripting hosts take 10-60s+ cold); the default 10s request
   * timeout would kill them. Only the initialize call uses this.
   */
  startupTimeoutMs?: number;
  /**
   * Spawn-directory override (supports `$HOME`). Some servers write session
   * state into their cwd (e.g. PowerShellEditorServices.json) — pin them to a
   * cache dir so they don't pollute the project root. The workspace/rootUri
   * stay the project root regardless.
   */
  cwd?: string;
}

export function fileToUri(filePath: string): string {
  const abs = path.resolve(filePath);
  return `file://${abs}`;
}

export function uriToFile(uri: string): string {
  return uri.replace(/^file:\/\//, "");
}

/** Build the URI to SEND to the server for a host file path (container-translated when mapped). */
export function serverUriFor(client: LspClient, filePath: string): string {
  return fileToUri(pathToServer(filePath, client.pathMap));
}

/** Translate a URI received FROM the server into a host URI (no-op when map is null). */
export function translateLocationUri(uri: string, map: PathMap | null): string {
  if (!map) return uri;
  return fileToUri(pathFromServer(uriToFile(uri), map));
}

/** Translate a WorkspaceEdit's URIs from server→host (no-op when map is null). */
export function translateWorkspaceEdit(edit: WorkspaceEdit, map: PathMap | null): WorkspaceEdit {
  if (!map) return edit;
  const changes: Record<string, TextEdit[]> = {};
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    changes[translateLocationUri(uri, map)] = edits;
  }
  const documentChanges = edit.documentChanges?.map((dc) => {
    if (!dc || typeof dc !== "object") return dc;
    if ("textDocument" in dc && dc.textDocument) {
      return { ...dc, textDocument: { ...dc.textDocument, uri: translateLocationUri(dc.textDocument.uri, map) } };
    }
    if ("kind" in dc) {
      if (dc.kind === "create" || dc.kind === "delete") {
        return { ...dc, uri: translateLocationUri(dc.uri, map) };
      }
      if (dc.kind === "rename") {
        return { ...dc, oldUri: translateLocationUri(dc.oldUri, map), newUri: translateLocationUri(dc.newUri, map) };
      }
    }
    return dc;
  });
  return { changes: Object.keys(changes).length ? changes : undefined, documentChanges };
}

/** Resolve a symbol position to a call-hierarchy root item (`textDocument/prepareCallHierarchy`). */
export async function prepareCallHierarchy(
  client: LspClient,
  uri: string,
  position: Position,
): Promise<CallHierarchyItem[]> {
  const raw = (await client.request("textDocument/prepareCallHierarchy", {
    textDocument: { uri },
    position,
  })) as CallHierarchyItem | CallHierarchyItem[] | null;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/** List the symbols that call the given item (`callHierarchy/incomingCalls`). */
export async function incomingCalls(client: LspClient, item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
  return ((await client.request("callHierarchy/incomingCalls", { item })) as CallHierarchyIncomingCall[] | null) ?? [];
}

/** List the symbols the given item calls (`callHierarchy/outgoingCalls`). */
export async function outgoingCalls(client: LspClient, item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
  return ((await client.request("callHierarchy/outgoingCalls", { item })) as CallHierarchyOutgoingCall[] | null) ?? [];
}

/**
 * Detect language ID from file extension.
 */
export function detectLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".rs": "rust",
    ".go": "go",
    ".mod": "gomod",
    ".py": "python",
    ".pyi": "python",
    ".nix": "nix",
    ".lua": "lua",
    ".sh": "shellscript",
    ".bash": "shellscript",
    ".zsh": "shellscript",
    ".json": "json",
    ".jsonc": "jsonc",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".md": "markdown",
    ".html": "html",
    ".htm": "html",
    ".css": "css",
    ".scss": "scss",
    ".less": "less",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".java": "java",
    ".cs": "csharp",
    ".ps1": "powershell",
    ".psm1": "powershell",
    ".psd1": "powershell",
    ".zig": "zig",
    ".xml": "xml",
    ".xsd": "xml",
    ".xsl": "xml",
    ".dockerfile": "dockerfile",
    ".rb": "ruby",
    ".ex": "elixir",
    ".exs": "elixir",
    ".hs": "haskell",
    ".swift": "swift",
  };
  return map[ext] ?? (base === "Dockerfile" ? "dockerfile" : "plaintext");
}

/**
 * Strip reserved metadata keys from a config object. Currently supports:
 *   _comment  — string or array of strings (inline notes)
 *   _meta     — arbitrary object (future-proofing)
 * These are never passed to the LSP server.
 */
function stripMeta(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "_comment" || key === "_meta") continue;
    result[key] =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? stripMeta(value as Record<string, unknown>)
        : value;
  }
  return result;
}

/**
 * Load project-specific LSP settings from .lsp/<server-name>.json.
 * Supports _comment and _meta fields for inline notes (stripped before merging).
 * Settings are deep-merged with server defaults (project settings take priority).
 * Returns empty object if no .lsp/ directory or file exists.
 */
export async function loadLspSettings(cwd: string, serverName: string): Promise<Record<string, unknown>> {
  // `.lsp/` lives at the devcontainer root (git root) when one exists, else the
  // server root — one config location per repo regardless of where the server
  // root sits (e.g. a subproject under the repo that owns the devcontainer).
  const base = findDevcontainerRoot(cwd) ?? cwd;
  const lspDir = path.join(base, ".lsp");
  const settingsFile = path.join(lspDir, `${serverName}.json`);

  if (!fs.existsSync(lspDir)) return {};

  try {
    const raw = await fs.promises.readFile(settingsFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".lsp/<server>.json must contain a JSON object");
    }
    return stripMeta(parsed);
  } catch {
    // No .lsp/ dir, no file, or parse error — return empty
    return {};
  }
}

/**
 * Check if any root marker exists in a directory.
 */
export function hasRootMarkers(cwd: string, markers: RootMarker[]): boolean {
  for (const marker of markers.flat()) {
    if (marker.includes("*")) {
      // Simple glob: check if any file matches
      try {
        const dir = fs.readdirSync(cwd);
        const pattern = marker.replace("*", "");
        if (dir.some((f) => f.endsWith(pattern))) return true;
      } catch {}
    } else if (fs.existsSync(path.join(cwd, marker))) {
      return true;
    }
  }
  return false;
}

/**
 * Find the project root for a file by walking up directories to find root markers.
 *
 * `nearest` (the default) returns the closest directory holding any marker. `markers` tries
 * the server's tiers in order and returns the closest directory inside the first tier that
 * holds any of its markers, so a project file outranks a nearer, weaker marker: a tree
 * holding a `package.json` and no `tsconfig.json` would otherwise root tsserver at the
 * package, which gives it an inferred project and no `paths`. The `markers` walk also stops
 * at the repository root (or the filesystem root outside a repository), so a project file
 * above the checkout is not this file's project; `nearest` is unbounded.
 */
export function findProjectRoot(
  filePath: string,
  rootMarkers: RootMarker[],
  strategy: RootStrategy = "nearest",
): string | null {
  const start = path.dirname(path.resolve(filePath));
  const tiers =
    strategy === "markers"
      ? rootMarkers.map((entry) => (Array.isArray(entry) ? entry : [entry]))
      : [rootMarkers.flat()];
  const limit = strategy === "markers" ? repositoryRoot(start) : null;
  for (const tier of tiers) {
    for (const dir of ancestors(start, limit)) {
      if (hasRootMarkers(dir, tier)) return dir;
    }
  }
  return null;
}

/** The directories from `start` up to `limit` (or the filesystem root when there is none). */
function ancestors(start: string, limit: string | null): string[] {
  const dirs: string[] = [];
  let dir = start;
  while (true) {
    dirs.push(dir);
    if (dir === limit) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

/** The nearest ancestor holding `.git`, or null when the file is outside a repository. */
function repositoryRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Create and initialize an LSP client.
 *
 * When `target` is provided, the server is spawned inside the devcontainer via
 * `docker exec -i` (see devcontainer.ts), URIs are translated across the wire, and
 * `processId` is sent as null (container servers can't see the host pid — some
 * vscode-* servers crash monitoring it). When omitted, runs the server on the host.
 */
export interface ClientHandlers {
  /** Apply a server-initiated workspace edit (inbound `workspace/applyEdit`) to disk. */
  onApplyEdit?: (edit: WorkspaceEdit) => Promise<boolean>;
  /** Serve a server-initiated rename refresh (inbound `_typescript.rename`). */
  onRename?: (params: { textDocument: { uri: string }; position: Position }) => Promise<unknown>;
}

export async function createClient(
  name: string,
  config: ServerConfig,
  cwd: string,
  target?: ContainerTarget | null,
  opts?: { timeoutMs?: number } & ClientHandlers,
): Promise<LspClient> {
  const { timeoutMs = config.startupTimeoutMs ?? 10_000, onApplyEdit, onRename } = opts ?? {};
  const pathMap = target?.pathMap ?? null;
  // The server's view of its root: container path when in a devcontainer, host cwd otherwise.
  const serverRoot = pathToServer(cwd, pathMap);

  let proc: ChildProcess;
  if (target) {
    // Container mode: `exec "$@"` with positionals [bash-label, command, ...args]
    // runs `command args` under a login shell (PATH sees globally-installed bins).
    // `-i` keeps stdin open for JSON-RPC; no `-t` (TTY corrupts binary framing).
    // Node passes positionals as distinct argv elements — no shell quoting needed.
    proc = spawn(
      "docker",
      ["exec", "-i", target.containerName, "bash", "-lc", 'exec "$@"', "bash", config.command, ...(config.args ?? [])],
      { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } },
    );
  } else {
    // Host mode: resolve command via node_modules/.bin, .venv/bin, then PATH.
    const resolvedCommand = resolveCommand(config.command, cwd);
    if (!resolvedCommand) {
      throw new Error(`LSP server binary not found: ${config.command}`);
    }
    // Expand `$HOME` in args (e.g. jdtls `-data $HOME/.cache/jdtls`): args
    // reach spawn() verbatim with no shell, so a literal `~` or `$HOME`
    // would otherwise go to the server as-is.
    const home = process.env.HOME ?? "";
    const args = (config.args ?? []).map((a) => (home ? a.replaceAll("$HOME", home) : a));
    // Pinned spawn cwd: servers that write session state into their cwd
    // (PowerShellEditorServices.json) get a cache dir instead of the project
    // root. Create it — spawn fails on a missing cwd.
    let spawnCwd = cwd;
    if (config.cwd) {
      spawnCwd = home ? config.cwd.replaceAll("$HOME", home) : config.cwd;
      fs.mkdirSync(spawnCwd, { recursive: true });
    }
    proc = spawn(resolvedCommand, args, {
      cwd: spawnCwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
  }

  // Collect stderr for error reporting
  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    // Keep only last 2KB
    if (stderrBuf.length > 2048) stderrBuf = stderrBuf.slice(-2048);
  });

  const transport = createTransport(proc);
  const diagnostics = new Map<string, Diagnostic[]>();
  let diagnosticsVersion = 0;

  const registeredWatchers: RegisteredWatcher[] = [];

  // Handle diagnostic notifications. Translate the URI container→host so the
  // diagnostics map is host-keyed (callers look up by host uri via fileToUri()).
  transport.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
    const p = params as { uri: string; diagnostics: Diagnostic[] };
    const hostUri = pathMap ? fileToUri(pathFromServer(uriToFile(p.uri), pathMap)) : p.uri;
    diagnostics.set(hostUri, p.diagnostics);
    diagnosticsVersion++;
  });

  // Handle server-to-client requests
  transport.onRequest("client/registerCapability", (params: unknown) => {
    const p = params as {
      registrations: Array<{
        id: string;
        method: string;
        registerOptions?: {
          watchers?: Array<{ globPattern: string | { baseUri?: string; pattern: string }; kind?: number }>;
        };
      }>;
    };
    for (const reg of p.registrations) {
      if (reg.method === "workspace/didChangeWatchedFiles" && reg.registerOptions?.watchers) {
        for (const w of reg.registerOptions.watchers) {
          const glob = typeof w.globPattern === "string" ? w.globPattern : w.globPattern.pattern;
          registeredWatchers.push({ globPattern: glob, kind: w.kind ?? 7 });
        }
      }
    }
    return null;
  });

  transport.onRequest("client/unregisterCapability", (params: unknown) => {
    const p = params as { unregisterations: Array<{ id: string; method: string }> };
    for (const unreg of p.unregisterations) {
      if (unreg.method === "workspace/didChangeWatchedFiles") {
        // Remove all watchers (unregister doesn't specify which patterns, just the registration ID)
        registeredWatchers.length = 0;
      }
    }
    return null;
  });

  transport.onRequest("workspace/configuration", (params: unknown) => {
    // Return empty settings for each requested item
    const p = params as { items?: unknown[] };
    return (p.items ?? []).map(() => ({}));
  });

  // Initialize
  // Merge server defaults with project-specific .lsp/<server>.json settings
  const projectSettings = await loadLspSettings(cwd, name);
  const initOptions = projectSettings
    ? deepMerge(config.initOptions ?? {}, projectSettings)
    : (config.initOptions ?? {});

  const initResult = (await Promise.race([
    transport.request(
      "initialize",
      {
        // Container servers can't see the host pid; some vscode-* servers crash
        // monitoring it. Null is the safe value across all servers.
        processId: target ? null : process.pid,
        capabilities: CLIENT_CAPABILITIES,
        rootUri: fileToUri(serverRoot),
        workspaceFolders: [{ uri: fileToUri(serverRoot), name: path.basename(cwd) }],
        initializationOptions: initOptions,
      },
      timeoutMs,
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`LSP initialize timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ])) as { capabilities: ServerCapabilities };

  transport.notify("initialized", {});

  // Send initial settings if configured
  if (config.settings) {
    transport.notify("workspace/didChangeConfiguration", { settings: config.settings });
  }

  const openFiles = new Map<string, number>();
  const progressMap = new Map<string | number, WorkDoneProgress>();

  // Handle work done progress notifications
  // window/workDoneProgress/create is a server-to-client request
  transport.onRequest("window/workDoneProgress/create", (_params: unknown) => {
    // Just acknowledge -- the actual progress comes via $/progress
    return null;
  });

  // Command-only actions (e.g. TypeScript's move-to-file) have the SERVER apply
  // the edit: typescript-language-server sends an inbound workspace/applyEdit
  // request and expects { applied }. Serve it by applying to disk + syncing.
  if (onApplyEdit) {
    transport.onRequest("workspace/applyEdit", async (params) => {
      const edit = (params as { edit?: WorkspaceEdit })?.edit;
      if (!edit) return { applied: false };
      const ok = await onApplyEdit(edit);
      return { applied: ok };
    });
  }
  // tls follows applyEdit with an inbound `_typescript.rename` refresh request.
  if (onRename) {
    transport.onRequest("_typescript.rename", (params) =>
      onRename(params as Parameters<NonNullable<ClientHandlers["onRename"]>>[0]),
    );
  }

  transport.onNotification("$/progress", (params: unknown) => {
    const p = params as { token: string | number; value: Record<string, unknown> };
    const token = p.token;
    const kind = p.value.kind;

    if (kind === "begin") {
      const wp: WorkDoneProgress = {
        token,
        state: "started",
        title: (p.value.title as string) ?? "",
        message: p.value.message as string | undefined,
        percentage: p.value.percentage as number | undefined,
        lastUpdated: Date.now(),
      };
      progressMap.set(token, wp);
      client.onProgress?.(wp);
    } else if (kind === "report") {
      const existing = progressMap.get(token);
      if (existing) {
        existing.state = "reporting";
        existing.message = (p.value.message as string) ?? existing.message;
        existing.percentage = (p.value.percentage as number) ?? existing.percentage;
        existing.lastUpdated = Date.now();
        client.onProgress?.(existing);
      }
    } else if (kind === "end") {
      const existing = progressMap.get(token);
      if (existing) {
        existing.state = "done";
        existing.message = (p.value.message as string) ?? existing.message;
        existing.lastUpdated = Date.now();
        client.onProgress?.(existing);
      }
      progressMap.delete(token);
    }
  });

  const client: LspClient = {
    createdAt: Date.now(),
    proc,
    name,
    languageId: config.languageId,
    command: [config.command, ...(config.args ?? [])].join(" "),
    pathMap,
    containerName: target?.containerName,
    capabilities: initResult.capabilities,
    pullDiagnostics:
      initResult.capabilities.diagnosticProvider !== undefined && initResult.capabilities.diagnosticProvider !== null,
    openFiles,
    diagnostics,
    // Live, not a snapshot: the push-diagnostics handler below increments the
    // closure variable, so the property must read it at access time or the
    // engine's "did the server respond?" check (diagnosticsVersion > prev)
    // never fires for push servers. A plain shorthand would copy the value at
    // construction and stay 0 forever. The setter backs the pull path's `++`.
    get diagnosticsVersion() {
      return diagnosticsVersion;
    },
    set diagnosticsVersion(v: number) {
      diagnosticsVersion = v;
    },
    registeredWatchers,
    progress: progressMap,
    onProgress: undefined,
    request: transport.request,
    notify: transport.notify,
    dead: false,

    async shutdown() {
      if (client.dead) return;
      client.dead = true;
      try {
        await Promise.race([transport.request("shutdown", null), new Promise((resolve) => setTimeout(resolve, 3000))]);
        transport.notify("exit", null);
      } catch {
        // Best effort
      }
      transport.cleanup();
      proc.kill();
    },
  };

  // Handle process exit
  proc.on("exit", () => {
    client.dead = true;
    transport.cleanup();
  });

  return client;
}

// ── Pull diagnostics ──

/**
 * State for pull-based diagnostics (`textDocument/diagnostic`). Servers that
 * advertise `diagnosticProvider` — e.g. the TS7 native LSP — don't push
 * `textDocument/publishDiagnostics` for source files; the client must ask.
 * After every didOpen/didChange/didSave (and watcher events, since
 * `interFileDependencies` means one file's diagnostics can change because a
 * DIFFERENT file changed) we re-pull with a short debounce.
 */
interface PullState {
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every scheduled pull; a response is applied only if it is the newest. */
  seq: number;
}

const pullStates = new WeakMap<LspClient, Map<string, PullState>>();

const PULL_DEBOUNCE_MS = 250;

/**
 * Extract the diagnostic items from a pull response. `kind: "full"` replaces
 * the stored list; `"unchanged"` keeps it (server signals nothing moved).
 */
export function diagnosticsFromPullReport(report: unknown): Diagnostic[] | null {
  if (!report || typeof report !== "object") return null;
  const r = report as { kind?: string; items?: unknown };
  if (r.kind === "unchanged") return null;
  if (!Array.isArray(r.items)) return null;
  return r.items.filter((d): d is Diagnostic => d !== null && typeof d === "object" && "message" in d && "range" in d);
}

function scheduleDiagnosticsPull(client: LspClient, hostUri: string): void {
  if (!client.pullDiagnostics || client.dead) return;
  let perClient = pullStates.get(client);
  if (!perClient) {
    perClient = new Map();
    pullStates.set(client, perClient);
  }
  let state = perClient.get(hostUri);
  if (!state) {
    state = { timer: undefined, seq: 0 };
    perClient.set(hostUri, state);
  }
  state.seq++;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void runDiagnosticsPull(client, hostUri, state);
  }, PULL_DEBOUNCE_MS);
  state.timer.unref?.();
}

async function runDiagnosticsPull(client: LspClient, hostUri: string, state: PullState): Promise<void> {
  const seq = state.seq;
  try {
    const report = await client.request("textDocument/diagnostic", {
      textDocument: { uri: serverUriFor(client, uriToFile(hostUri)) },
    });
    if (client.dead || seq !== state.seq) return; // superseded by a newer pull
    const items = diagnosticsFromPullReport(report);
    if (items === null) return; // unchanged or malformed — keep current
    client.diagnostics.set(hostUri, items);
    client.diagnosticsVersion++;
  } catch {
    // Server declined/timed out — keep last known diagnostics.
  }
}

/**
 * Open a file in the LSP server (textDocument/didOpen). No-op if already open.
 */
export async function openFile(client: LspClient, filePath: string): Promise<void> {
  const hostUri = fileToUri(filePath);
  if (client.openFiles.has(hostUri)) return;

  const content = await fs.promises.readFile(filePath, "utf-8");
  const languageId = client.languageId ?? detectLanguageId(filePath);
  client.openFiles.set(hostUri, 1);

  client.notify("textDocument/didOpen", {
    textDocument: { uri: serverUriFor(client, filePath), languageId, version: 1, text: content },
  });
  scheduleDiagnosticsPull(client, hostUri);
}

/**
 * Sync file content to LSP server (didOpen or didChange).
 * Returns the synced text (for passing to notifySaved with includeText).
 */
export async function syncFile(client: LspClient, filePath: string, content?: string): Promise<string> {
  const hostUri = fileToUri(filePath);
  const text = content ?? (await fs.promises.readFile(filePath, "utf-8"));
  const uri = serverUriFor(client, filePath);

  if (!client.openFiles.has(hostUri)) {
    const languageId = client.languageId ?? detectLanguageId(filePath);
    client.openFiles.set(hostUri, 1);
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  } else {
    const version = (client.openFiles.get(hostUri) ?? 0) + 1;
    client.openFiles.set(hostUri, version);
    client.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }
  scheduleDiagnosticsPull(client, hostUri);
  return text;
}

/**
 * Close a file in the LSP server (textDocument/didClose).
 * Removes from openFiles tracking. Servers drop their in-memory state for the file.
 */
export function closeFile(client: LspClient, filePath: string): void {
  const hostUri = fileToUri(filePath);
  if (!client.openFiles.has(hostUri)) return;
  client.openFiles.delete(hostUri);
  client.notify("textDocument/didClose", { textDocument: { uri: serverUriFor(client, filePath) } });
}

/**
 * Notify the server that a file was saved.
 * Includes file text if the server requested it via capabilities.
 */
export function notifySaved(client: LspClient, filePath: string, text?: string): void {
  const uri = serverUriFor(client, filePath);
  const sync = client.capabilities.textDocumentSync;
  const wantsText = typeof sync === "object" && typeof sync.save === "object" && sync.save.includeText === true;

  if (wantsText && text !== undefined) {
    client.notify("textDocument/didSave", { textDocument: { uri }, text });
  } else {
    client.notify("textDocument/didSave", { textDocument: { uri } });
  }
  scheduleDiagnosticsPull(client, fileToUri(filePath));
}

/** FileChangeType from LSP spec */
export const FileChangeType = { Created: 1, Changed: 2, Deleted: 3 } as const;

/**
 * Notify the server about file create/change/delete events.
 * Sends workspace/didChangeWatchedFiles so servers can update their index.
 */
export function notifyFileChanges(
  client: LspClient,
  changes: Array<{ uri: string; type: (typeof FileChangeType)[keyof typeof FileChangeType] }>,
): void {
  if (changes.length === 0) return;
  // Callers pass host URIs (built via fileToUri); translate to server URIs for the wire.
  const mapped = client.pathMap
    ? changes.map((c) => ({
        uri: fileToUri(pathToServer(uriToFile(c.uri), client.pathMap)),
        type: c.type,
      }))
    : changes;
  client.notify("workspace/didChangeWatchedFiles", { changes: mapped });
  // interFileDependencies: a change to file B can change file A's diagnostics.
  // Re-pull every open file of this server, not just the changed ones.
  for (const hostUri of client.openFiles.keys()) {
    scheduleDiagnosticsPull(client, hostUri);
  }
}

/**
 * Resolve a command to an executable path.
 * Checks project-local bin directories, then PATH.
 */
export function resolveCommand(command: string, cwd: string): string | null {
  // Check node_modules/.bin
  const nmBin = path.join(cwd, "node_modules", ".bin", command);
  if (fs.existsSync(nmBin)) return nmBin;

  // Check .venv/bin
  const venvBin = path.join(cwd, ".venv", "bin", command);
  if (fs.existsSync(venvBin)) return venvBin;

  // Check PATH
  const { execSync } = require("node:child_process");
  try {
    const resolved = execSync(`which ${command}`, { encoding: "utf-8", timeout: 3000 }).trim();
    if (resolved) return resolved;
  } catch {
    // Not found
  }

  return null;
}
