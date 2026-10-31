# LSP Extension

Language Server Protocol integration for pi. Gives the agent IDE-like code intelligence: type checking, go-to-definition, hover info, find references, symbol navigation, and lint feedback.

## What it does

1. **`lsp` tool** — the LLM can call this directly for type-checking and navigation: diagnostics, go-to-definition, hover, find references, symbols, workspace symbol search, rename, code actions, and restart (the tool's action enum has the full set, including `type_definition`, `implementation`, `workspace_symbol`, `restart`, and `status`)
2. **Auto-diagnostics** — after every edit/write/patch, LSP diagnostics + linter results are appended to the tool result, even when clean, so the model always sees its code's status without asking
3. **Auto-detection** — discovers available language servers and CLI linters from project markers + PATH
4. **Multi-root support** — roots each file's LSP server at that file's project (e.g., rust-analyzer at the Cargo.toml ancestor, not the session dir), inside and outside the session cwd. Clients are keyed by `serverName::rootPath` so multiple instances of the same server type can coexist.
5. **Workspace symbol search** — `workspace_symbol` action searches across all active LSP servers by symbol name, returning matches from the entire project (not just one file)
6. **File watcher** — watches cwd recursively, sends `workspace/didChangeWatchedFiles` to servers when files are created, changed, or deleted (including via bash). Respects `.gitignore` via `git check-ignore`, with hardcoded fallbacks for non-git directories.
7. **Server request handling** — responds to `client/registerCapability` (stores watcher glob patterns), `client/unregisterCapability`, and `workspace/configuration`
8. **Cold server gating** — if a server times out on auto-diagnostics or a `symbols` call, it's marked cold and skipped for 5s to avoid blocking edits. Linters always run (they're fast CLI calls).
9. **Code actions** — `codeAction` lists available refactorings/fixes at a position, `codeActionApply` executes one by its index. Supports `codeAction/resolve` for deferred edits.
10. **Progress reporting** — tracks `window/workDoneProgress` from servers and shows progress (title, percentage) in the footer status bar. Stale progress entries are expired after 30s.
11. **Devcontainer support** — when a project has a running `.devcontainer/`, language servers can run inside it (with host↔container path translation), so the host doesn't need the project's dependencies. See [Devcontainer support](#devcontainer-support).
12. **Read-time warming** — when the agent `read`s a code file, it's opened in its LSP server in the background so the first interactive `symbols`/`hover`/`incoming` call is already warm. Invisible to the model and non-blocking. See [Read-time warming](#read-time-warming).
13. **Post-bash diagnostics** — after a `bash` command that changed files (formatter, checkout, codegen), diagnostics for the changed files are appended to the result as one batched report: per-file blocks for files with findings, a single `N files clean` line for the rest (capped at 5, with a `…and N more` tail). The agent rarely calls `lsp diagnostics` after bash; the file watcher knows what changed.
14. **Format drift report** — after an edit, repo-gated formatter servers (biome) are asked what the formatter would change (`textDocument/formatting`); the changed line ranges are reported in the diagnostics block. Non-mutating — the agent decides whether to run the formatter.
15. **Quickfix hints** — after an edit, servers are asked which of the file's diagnostics have an available quickfix (`textDocument/codeAction`); the titles are appended as `quickfix: <title> — apply via lsp codeActionApply`. Server-agnostic (tsserver "Add import…" and biome rule fixes both). Non-mutating.

## Supported servers

Auto-detects common language servers from project markers (TypeScript, Rust, Go, Python, Nix, Swift, Lua, Bash, YAML, TOML, Markdown, C/C++, Zig, and more). The server binary must be on PATH. The full list with file types and root markers lives in `servers.ts` (`KNOWN_SERVERS`).

Linters that speak LSP (oxlint, biome) are registered as servers but repo-gated: they only start when the project ships their config marker (`.oxlintrc.json` / `oxlint.config.ts` / `biome.json` etc.), and never lazy-start on touch. For a repo without the config that still wants one, force it via `.lsp/servers.json` `{ "enabled": ["oxlint"] }`.

## Commands

- `/lsp` — show detected servers and status
- `/lsp-restart` — restart all LSP servers (user command)
- `/lsp-dedup` — toggle collapsing of unchanged diagnostics in post-edit blocks (on by default; state is in-memory, resets on reload)

The agent can also restart servers via `lsp(action="restart")` (all servers) or `lsp(action="restart", file="...")` (server for a specific file's project).

## How auto-diagnostics work

When the model uses `edit`, `write`, or `patch` on a file that has an active language server:

1. The new content is synced to the LSP server (`didOpen` or `didChange` with incrementing version)
2. The server is notified of the save (`didSave`, with `includeText` if the server requests it)
3. For new files (not yet opened by any server), a `workspace/didChangeWatchedFiles` Created notification is sent first, with a longer 6s timeout for re-indexing
4. Diagnostics are collected (up to 3s timeout for existing files, 6s for new files)
5. A status line is appended to the tool result: the errors/warnings if any, or `no errors, no warnings` when clean. The model sees the result inline — no explicit `lsp diagnostics` call needed after edits.
6. Diagnostics already shown in an earlier post-edit block collapse: unchanged errors (same source, code, and message — position ignored, since an edit above an error shifts its line) shrink to a single location line, and only new diagnostics get full detail. The summary counts both, so an unfixed error is never invisible. The ledger is per-file, per-session; a file that goes clean is forgotten, and a new session re-reports everything once. Explicit `lsp diagnostics` calls always show the full set.
7. Format drift (post-edit only): if a repo-gated server (biome — its config marker opts the project into the formatter) would change the file, the changed line ranges are appended as `format drift: 2-4`. Reported, never applied — the agent runs the formatter itself; the point is that its next patch must target formatted content, not the stale text it last wrote.
8. Quickfix hints (post-edit only): for each server's diagnostics on the file, the extension asks which have an available quickfix (`textDocument/codeAction`) and appends `quickfix: <title> — apply via lsp codeActionApply`. Server-agnostic; suppress/disable actions are filtered out; capped at 3 hints per file.

The file watcher also handles changes made via bash (e.g., `rm`, `echo >`, `git checkout`). When a file is deleted, `didClose` is sent before the deletion notification so servers like tsserver drop their cached state.

The model sees something like:

```
Successfully edited src/main.ts

[LSP diagnostics (typescript-language-server): 1 error(s)]
src/main.ts:42:5 [error] (ts) [2345] Argument of type 'string' is not assignable to parameter of type 'number'
```

When an edit doesn't change the diagnostic picture, the already-shown errors collapse:

```
[LSP diagnostics (typescript-language-server): 2 error(s) — 1 new, 1 unchanged]
src/main.ts:40:3 [error] (ts) [2345] Argument of type 'string' is not assignable to parameter of type 'number'
  unchanged: src/main.ts:42
```

UI notifications carry the same collapsed form — the user is reminded something
is wrong without getting the same wall of messages re-listed on every edit.
Toggle the behavior with `/lsp-dedup` (off: unchanged errors are reported in
full again; `lsp status` shows the state while off).

## Read-time warming

When the agent `read`s a code file, the extension opens it in its LSP server in
the background (`textDocument/didOpen`), so the first interactive call
(`symbols`, `hover`, `incoming`, ...) on that file is warm instead of paying
cold-parse latency.

Best-effort and non-blocking: the read completes immediately and failures are
ignored. Only files a detected server already handles are warmed — a `read`
never triggers new server discovery (that stays an `lsp` tool concern). A
server not yet running starts on demand, matching session-start warming. The
model sees no change to read output, but the first LSP call on the file answers
fast.

## Post-edit caller warning

Diagnostics catch what *broke*; they don't catch what an edit might have *broken*. Changing a function's body or signature can invalidate its callers even when
it still type-checks. After every edit-like tool, the extension:

1. Captures the file's pre-edit content at `tool_call`
2. Diffs pre vs post content to find which top-level symbols the edit touched
3. For each touched symbol (up to 4), lists its incoming call sites via call
   hierarchy (up to 6 per symbol), appended to the tool result

Caller sites that land on the edit's own changed lines are skipped — those are
the edit's new references (e.g. a newly added function plus the call to it),
which the diff already shows. Only the external blast radius is reported:
callers in unchanged parts of the file or other files.

The model sees call sites to check without hunting for them:

```
[LSP callers (ts): 2 symbol(s) changed — call sites to check]
  validateToken (src/api.ts:12): src/auth.ts:88, src/ui.ts:5 (+1 more)
  UserService (src/b.ts:50): src/app.ts:3
```

Best-effort only — cold servers, missing call-hierarchy support, or lookups
that fail simply produce no block. It must never block the edit.

or, when the edit is clean:

```
Successfully edited src/main.ts

[LSP diagnostics (typescript-language-server, biome): no errors, no warnings]
```

All servers and linters that ran are listed in the parenthetical, one line per edited file. Clean results don't raise a UI notification — only actual issues do.

## Symbols

The `symbols` action renders `textDocument/documentSymbol` as a compact declaration skeleton with line ranges, so the agent can `read` with `offset`/`limit` for just the symbol it needs.

```
[?] rpc.ts (implicit module) (Module) @ lines 1-802
  [c] SUBAGENT_SESSION_DIR (Constant) @ line 18
  [I] UsageStats (Interface) @ lines 42-50
    [p] input (Property) @ line 43
  [F] runSingleAgent (Function) @ lines 243-802
```

<details>
<summary>Filtering, line ranges, cold-server handling</summary>

- **Container/body filter** — only containers (Module/Class/Struct/Interface/Enum/Namespace/Object/Package) recurse; body kinds (Function/Method/Property/Field/Constant/Variable) are leaves. Collapses tsserver's per-callback scope-tree noise (~350 → ~50 lines). No-op for Rust.
- **Line ranges** — full extent (doc comments, decorators), read-ready: `@ line 42` / `@ lines 243-802`; LSP's exclusive `range.end` at a line boundary is handled.
- **Cold server** — first call on an unanalyzed file may hit the 10s timeout; returns "retry immediately / fall back to read" (not a raw error), marks the server cold, clears on success.
- A `promptGuideline` steers the agent to call `symbols` before `read` on capable-server languages, excluding weak ones (nixd, bash-language-server).

</details>

## Workspace Symbol Search

The `workspace_symbol` action searches for symbols across the entire project by name. Unlike `symbols` (which lists all symbols in one file), `workspace_symbol` queries all active LSP servers.

**Parameters:**
- `action: "workspace_symbol"` — the action to perform
- `query: string` — symbol name query (matching behavior is server-dependent: some do substring, some prefix, some fuzzy)

**Behavior:**
- Broadcasts `workspace/symbol` to all active LSP clients (across all roots)
- Results are sorted alphabetically by symbol name
- Each result shows the symbol kind, container name, and file location
- Returns up to the server's limit (typically 50-200 results)

**When to use:** Finding a function/type/class when you know the name but not the file. More precise than `rg` for symbols (respects scoping, includes types/interfaces, handles overloads).

**Example:** `lsp(action="workspace_symbol", query="handleInput")` — finds all symbols matching "handleInput" across the project.

## Call hierarchy

`lsp incoming` / `lsp outgoing` answer "who calls this?" / "what does this
call?" via `textDocument/prepareCallHierarchy` + `callHierarchy/incomingCalls` /
`outgoingCalls`. Useful for refactor blast-radius: check `incoming` before
changing a symbol's contract, `outgoing` to see what an unfamiliar function
depends on. The post-edit caller warning uses the same provider internally.

## Multi-root Support

Each file's server roots at that file's project, and TypeScript prefers a project file over a nearer package manifest. The walk rules are in `findProjectRoot`'s doc; `rootStrategy` picks a walk per server. Clients are keyed `serverName::rootPath`, so several instances coexist (e.g. one rust-analyzer per project). `lsp status` shows servers at other roots too.

## Files

The extension splits into a thin pi adapter (`index.ts`) and a harness-agnostic
engine (everything else — no pi imports, reusable with another agent harness).
The engine returns plain text; a harness that wants a different format (e.g.
HTML) renders the same data itself.

| File | Purpose |
|------|---------|
| index.ts | Pi adapter only: session events, tool/command registration, UI notifications, footer status rendering |
| state.ts | Engine state + shared types (LspHost, LSP_ACTIONS, EngineStatusData, constants) |
| client-mgmt.ts | Server/client resolution (getClientForFile, getClientAt, restart), path overrides, gated linters |
| diagnostics.ts | Diagnostic collection pipeline (getDiagnosticsForFile), diagBlock rendering |
| hooks.ts | tool_call/tool_result hooks: read warming, pre-edit capture, post-edit/post-bash drains, caller warnings |
| file-events.ts | Watcher routing (didChangeWatchedFiles), session start/stop |
| status.ts | Status facts (updateStatusData), statusReport, dedup toggle |
| actions.ts | The `lsp` tool's action implementations (runAction switch) |
| watcher.ts | File system watcher (fs.watch recursive, git check-ignore filtering, debounce) |
| watcher.test.ts | Tests for file watcher |
| client.ts | JSON-RPC client over stdio, LSP protocol handling, server request handlers, progress tracking (10s request timeout) |
| servers.ts | Known server configs, auto-detection, dynamic tsserver memory scaling |
| linters.ts | CLI linter configs (golangci-lint), detection, JSON output parsing |
| drift.ts | Format drift detection: `textDocument/formatting` → changed line ranges |
| drift.test.ts | Tests for collapseRanges |
| format.ts | Formatting utilities (diagnostics, locations, symbols, hover, workspace edit application) |
| format.test.ts | Tests for formatting |
| servers.test.ts | Tests for server configs, file matching, memory scaling |
| linters.test.ts | Tests for linter configs, golangci-lint output parsing |
| client.test.ts | Tests for project root detection |
| engine.test.ts | Engine orchestration tests with a mock host (no real servers) |
| e2e.test.ts | Live server tests (gated by `LSP_E2E=1`), incl. engine-driven pipeline tests |

## Per-project configuration (`.lsp/` directory)

`.lsp/` lives at the project root, or the devcontainer/git root when one exists (so a single `.lsp/` covers the whole repo even when a server root is a subdirectory). All files are JSON; `_comment` and `_meta` are reserved.

### `.lsp/<server>.json` — per-server settings + container install

Deep-merged into the server's `initializationOptions`. Reserved keys: `_comment`/`_meta` (stripped), `_container` (force a compose service; devcontainer mode), `_containerInstall` (shell command(s) to install the server in the container if missing — see [Devcontainer support](#devcontainer-support)).

```json
// .lsp/rust-analyzer.json
{
  "_comment": "RSX proc macros generate untypeable code; rustc compiles clean, rust-analyzer does not.",
  "procMacro": { "ignored": { "dioxus-core-macro": ["rsx", "component"] } }
}
```

### `.lsp/devcontainer.json` — project-wide devcontainer overrides

- `disabled` (bool) — force host-side servers even when a devcontainer is running.
- `extraMaps` (`[{ "host": "...", "container": "..." }]`) — additional host↔container path mappings beyond the auto-detected bind mount.

### `.lsp/linters.json` — enable/disable linters

```jsonc
{ "disabled": ["golangci-lint"] }
```

A linter runs only where its root marker is present by default. `enabled` forces it without the marker; `disabled` suppresses it. Priority: `disabled` > `enabled` > marker. LSP-based linters (oxlint, biome) use `.lsp/servers.json` instead.

### `.lsp/servers.json` — disable servers

```jsonc
{ "disabled": ["nixd"] }
```

Suppresses servers per-project. Servers don't need an `enabled` list — they lazy-start by file extension.

### `.lsp/config.json` — path overrides

Map a file path to a server regardless of extension, for files whose content is
a language their name hides (e.g. generated text files holding SQL):

```jsonc
{ "paths": { "config/*.conf": "taplo" } }
```

Globs match against the absolute path; the first match wins. Content sniffing
isn't a substitute — enry and pygments both read SQL-in-`.txt` as plain text.

## Devcontainer support

When a project has a running `.devcontainer/`, language servers can run **inside the container** (with host↔container path translation) so the host doesn't need the project's dependencies — e.g. a named volume hiding `node_modules` from the host would otherwise leave a host-side tsserver unable to resolve any imports.

Auto-detected when `.devcontainer/` exists and a container with the server binary is running; falls back to host otherwise. Override: `.lsp/devcontainer.json` `{ "disabled": true }`, `.lsp/<server>.json` `_container` (force a service), `_containerInstall` (install the binary in the container if missing).

### TypeScript 7 (native) vs classic TS ≤6

TypeScript 7 is the native Go build ("typescript-go") and ships **no `lib/tsserver.js`** — the classic `typescript-language-server` cannot run against it at all (its version resolver fails with `Could not find a valid TypeScript installation`). TS7 ships its own LSP: `tsc --lsp --stdio`.

The extension auto-detects the flavor per server root and picks the right command. Mixed setups work: when each package owns a tsconfig, a monorepo with a TS5 package and a TS7 package gets two servers with the right flavor each. Escape hatch: `.lsp/typescript-language-server.json` `_command`/`_args` override the auto-detection.

<details>
<summary>How flavor detection works</summary>

It walks up from the server root to the nearest `node_modules/typescript` (inside the container when one is used, else on the host) — `lib/tsserver.js` present ⇒ classic (`typescript-language-server`), absent ⇒ TS7 (`tsc --lsp --stdio`). The devcontainer container-probe looks for `tsc`, so `_containerInstall` for TypeScript projects should install **both** `typescript-language-server` and `typescript` — a fresh container for a TS ≤6 project still needs the classic server after detection picks it. The TS7 native server reports diagnostics via the pull model (`textDocument/diagnostic`) instead of pushing; the client polls after opens/edits/saves/watcher events when the server advertises `diagnosticProvider`.

</details>

<details>
<summary>How devcontainer mode works</summary>

On first use, the extension scans running containers and picks the one that bind-mounts the project root and has (or can install) the binary — probing each, so multi-service devcontainers work, not just the `service` in `devcontainer.json`. The server is spawned via `docker exec -i <container> bash -lc 'exec "$@"'`, URIs are translated both directions across the wire, and `processId` is sent as null (some servers crash monitoring it). `_containerInstall` runs as the container user (prefix `sudo` if it can't write the install prefix, e.g. `npm`'s global dir); if undeclared, a warning shows via `ctx.ui.notify` and it falls back to host for the session. `lsp status` / `/lsp` annotate each server with `[host]` or `[container:<name>]`.

</details>

## Adding new servers

Add entries to `KNOWN_SERVERS` in `servers.ts`. Required fields:
- `command`: binary name
- `args`: CLI args (usually `["--stdio"]` or `[]`)
- `fileTypes`: file extensions this server handles
- `rootMarkers`: files that indicate this server is relevant; nest names in an array for one tier of equivalent markers.
- `rootStrategy` (optional): `"nearest"` (default) or `"markers"`; `findProjectRoot`'s doc says what each does to the walk.

The server binary must be on PATH. Install via nix in `modules/home-manager/default.nix`.

## Adding new linters

Add entries to `KNOWN_LINTERS` in `linters.ts` and a runner function. See `runGolangciLint` for an example. Linters use `child_process.execFile` (not `Bun.spawn` -- pi runs in Node, not Bun). A linter runs only where its root marker is present (override via `.lsp/linters.json`).

## Code actions

`codeAction` lists actions at a position (kind, title, preferred/disabled, with context lines). `codeActionApply` runs one by index (or `name` — a substring of the title) — re-queries for freshness, resolves via `codeAction/resolve` if deferred, applies the edit to disk. Command-only actions (no edit attached) are executed via `workspace/executeCommand`; the server applies the refactor and the affected paths are reported back.

Caveat: the TS7 native server returns nothing for refactor actions by design (typescript-go#4005), so move-to-file and similar only work against classic TS ≤6.

<details>
<summary>WorkspaceEdit application details</summary>

`applyWorkspaceEdit` (format.ts) handles both forms: `changes` (tsserver) and `documentChanges` (rust-analyzer rename). `documentChanges` is authoritative when both are present (per spec); within a file, edits apply in reverse order to preserve positions. Resource operations (Create/Rename/Delete) are executed in `documentChanges` order (create/rename first, then the `TextDocumentEdit` that fills the file). An `onFileWritten` callback syncs each file back via `didChange` so round-trip edits use fresh positions.

For command-only actions, typescript-language-server applies the refactor itself: it sends an inbound `workspace/applyEdit` request (served by the client — apply to disk, sync files, record the touched paths) followed by an inbound `_typescript.rename` refresh. The `executeCommand` result is void; the reported paths come from the served applyEdit.

</details>

## Progress reporting

Servers send progress via `window/workDoneProgress/create` + `$/progress` notifications. The client tracks active progress tokens in a `Map` and exposes them via the `LspClient.progress` field. The extension:
- Shows active progress in the footer status bar (e.g., `lsp:rust-analyzer Building 45%`)
- Throttles status updates to 500ms to avoid flooding the TUI
- Expires stale entries after 30s (servers that sent `begin` but never `end`)
- Uses accent color for active progress, muted color for idle status

## Failure context

When an LSP action returns no results (no definition found, no hover info, no references, etc.), the response includes:
- **Position info**: the resolved position with resolution method (e.g., `(symbol "foo" at 42:15 via semantic)` or `(symbol "foo" not found at line 5)`)
- **Context lines**: 2 lines around the target line so the model can see what's actually there and retry with the correct parameters

For `rename` failures, 3 lines of context are shown. For `codeAction`, 5 lines.

## Position resolution

When `symbol` is provided, the cursor resolves via:

- **Semantic** (no `line`): `documentSymbol` tree search by name → declaration site. Best for "where is X defined."
- **Textual** (`line` given): word-boundary match on that line → usage site; falls back to nearest textual match, then semantic.

Word-boundary (`\b`) prevents `get` matching `getApiKey`.

## Tool call rendering

The collapsed tool call display shows the action, file, line, symbol, and rename target:
- `lsp definition index.ts:46 readLocationContext`
- `lsp rename index.ts:42 oldName → newName`
- `lsp codeAction index.ts:42 [3]`
- `lsp workspace_symbol "handleInput"`
- `lsp restart index.ts`

## Known limitations

- **tsserver in large monorepos**: first access to each TS project reference is slow (5-30s warmup). Cold server gating handles this gracefully.
- **TanStack Router types**: `createFileRoute`, `useLocation`, `Route` involve expensive type-level route tree inference. Hover on these symbols may always timeout. Partially addressed upstream (TanStack/router#1091, PR #1202) but fundamentally expensive for large route trees.
- **yamlls on large files**: `symbols` times out on YAML files >400 lines (now surfaces the graceful 'still indexing' message rather than a raw error). Diagnostics and hover work fine. Schema store is disabled to prevent network-blocking timeouts.
- **Files outside cwd**: the file watcher only covers cwd. Files in other directories get server-side watching via the LSP server's own watchers (registered via `client/registerCapability`), but bash-side file changes (e.g., `rm`, `echo >`) in external projects won't trigger notifications. Cross-file references within external projects work correctly via multi-root support: the server is rooted at the project's root-marker ancestor, not the session cwd.
- **Code actions**: servers that return command-only actions without implementing `workspace/executeCommand` can't be applied here — the client would have to interpret the command itself. The TS7 native server returns nothing for refactor actions at all (typescript-go#4005).
