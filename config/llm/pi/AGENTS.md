# AGENTS.md

Pi coding agent extensions and configuration, deployed via Nix (`modules/home-manager/pi.nix`).

## Quick Reference

```bash
mise pi-check    # biome lint + bun test
mise pi-fmt      # biome auto-fix
mise nix-diff    # verify Nix build after changes
```

## Key Paths

| What | Where |
|------|-------|
| Pi extension docs | `/opt/homebrew/Cellar/pi-coding-agent/*/libexec/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md` |
| Pi TUI component docs | Same path but `docs/tui.md` |
| Pi extension examples | Same path but `examples/extensions/` |
| Pi TUI type declarations | Same path but `node_modules/@earendil-works/pi-tui/dist/components/*.d.ts` |
| Nix module that deploys these | `modules/home-manager/pi.nix` |
| Shared LLM constants | `modules/home-manager/llm-shared.nix` |
| Global instructions | `config/llm/instructions.md` |

## Pi internals reference

When you need to understand how pi resolves models, loads extensions, or handles auth — read the source. Everything is JS (compiled from TS) in the pi package.

### Package layout

```
/opt/homebrew/opt/pi-coding-agent/libexec/lib/node_modules/@earendil-works/pi-coding-agent/
├── dist/                          # pi core (compiled JS + .d.ts)
│   ├── core/
│   │   ├── model-registry.js      # model resolution: built-in + models.json merge
│   │   ├── model-resolver.js      # model selection prompt parsing
│   │   ├── auth-storage.js        # API key resolution: auth.json → env vars → models.json
│   │   ├── sdk.js                 # ExtensionAPI, ExtensionContext types
│   │   └── ...                    # session-manager, keybindings, exec, etc.
│   └── docs/                      # extension docs, tui docs
├── node_modules/@earendil-works/
│   ├── pi-ai/                     # LLM provider abstraction
│   │   └── dist/
│   │       ├── models.js          # getProviders(), getModels() — built-in model catalog
│   │       ├── models.generated.js # static model definitions per provider
│   │       ├── env-api-keys.js    # getEnvApiKey() — env var → provider mapping
│   │       ├── stream.js          # completeSimple(), streaming API
│   │       └── providers/         # per-provider request formatting
│   │           ├── openai-completions.js  # most providers use this
│   │           ├── anthropic.js
│   │           └── ...                    # google, bedrock, mistral, etc.
│   ├── pi-tui/                    # terminal UI components (Input, SelectList, etc.)
│   └── pi-agent-core/             # shared agent logic
└── examples/extensions/          # example extensions
```

### Model resolution (`ModelRegistry`)

`dist/core/model-registry.js` — the `ModelRegistry` class. Key flow:

1. **Built-in models**: `pi-ai`'s `getProviders()` / `getModels()` return a static catalog of ~22 providers with model definitions (baseUrl, context window, costs, etc.). No config needed.
2. **Custom providers**: `~/.pi/agent/models.json` adds or overrides providers. Custom providers need `baseUrl` + `apiKey`. Built-in providers can be overridden (change baseUrl, add models).
3. **Merge**: `loadBuiltInModels()` then `mergeCustomModels()` — custom wins on `provider/id` conflicts.
4. **Auth priority**: `getApiKeyAndHeaders()` checks: runtime override → auth.json → env var (`getEnvApiKey()`) → models.json apiKey.

The benchmark's `shared.ts` replicates this merge logic (reads models.json + pi-ai built-ins) without instantiating `ModelRegistry` itself (which requires `AuthStorage`).

### Auth resolution (`AuthStorage` + `getEnvApiKey`)

`dist/core/auth-storage.js` — `AuthStorage` class. Priority chain for API keys:
1. Runtime override (CLI `--api-key`)
2. `~/.pi/agent/auth.json` (`api_key` or `oauth` credential)
3. Environment variable (`ANTHROPIC_API_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, etc.)
4. Fallback resolver (models.json `apiKey` field — supports `!command` prefix for shell execution)

`pi-ai`'s `env-api-keys.js` has the provider → env var mapping. Useful for knowing which env var a provider needs.

### When to read the source

- **Adding a new provider to models.json**: read `model-registry.js` `loadCustomModels()` and `validateConfig()` for schema rules.
- **Understanding model capabilities**: `pi-ai/dist/models.generated.js` has the full static model catalog with context windows, input types, costs.
- **Extension API questions**: LSP go-to-definition usually works, but `dist/core/sdk.js` has the `ExtensionAPI` / `ExtensionContext` definitions.
- **Auth debugging**: `auth-storage.js` `getApiKey()` shows the full resolution chain.

## Guidelines

- Multi-file extensions go in a subdirectory with `index.ts` as entry point and a README. Add a row to the extension table in `config/llm/pi/README.md`. See `ls config/llm/pi/extensions/` for current extensions.
- Extract testable logic into a pure module (no pi imports). Test with bun.
- All extensions are symlinked live to `~/.pi/agent/extensions/` — edit + `/reload` works without nix-switch.
- Runtime config (journal constants, model roles) is read from `~/.config/llm/journal.json` and `~/.pi/agent/roles.json` respectively.
- Auto-discovery: any directory under `config/llm/pi/extensions/` with an `index.ts` is symlinked automatically by `pi.nix` (the `allExtDirs` let binding reads the directory at eval time and generates symlink commands). Adding a new extension directory only requires `mise nix-switch` — no manual Nix edits. Directories without `index.ts` (like `shared/`) are also symlinked but pi only loads them as extensions if they have `index.ts`.
- Imports between extensions/shared modules use relative paths like `../shared/`. **Pi resolves relative imports from the symlink path** (`~/.pi/agent/extensions/<ext>/`), NOT the realpath — so imported code must exist as a *sibling* under `~/.pi/agent/extensions/`. `../shared/` works because `shared/` physically lives under `config/llm/pi/extensions/` (tsc finds it) AND `allExtDirs` symlinks it into the runtime extensions dir (Node finds it) — same relative position in both trees.
- To import code that lives **outside** `config/llm/pi/extensions/` (e.g. the MCP-tree web-search providers shared with other hosts), use a **bridge symlink** in two places: a repo symlink under `config/llm/pi/extensions/` (for tsc) and an explicit runtime symlink in the `pi.nix` `piExtensions` activation (for Node). See `web-search-core` (repo symlink + `pi.nix` entry pointing at `config/llm/mcp/web-search/providers`) for the example.
- Shared code goes in `extensions/shared/` (no `index.ts` = not discovered as an extension).
- **File-mutating tools** (e.g. `patch`): add the tool name to `EDIT_LIKE_TOOLS` in `shared/edit-tools.ts`. Extensions that react to edits (LSP diagnostics, permission-gate path checks, agents-file discovery) read from there, so a new edit tool is wired everywhere with one change instead of being silently skipped (LSP not firing after edits is the symptom of a miss). Use `collectToolPaths(toolName, input)` for path extraction — it handles patch's per-edit multi-file paths and dedupes.
- **Design for agent imprecision.** Agents are bad at exact byte reproduction (whitespace, indentation, Unicode) and counting (line numbers, edit indices). Extensions and tools should: (a) normalize inputs before matching — don't require the agent to get invisible bytes right; (b) include surrounding context when reporting locations — bare line numbers are ambiguous to agents, use `>>` + context lines; (c) include the closest match when a lookup fails — “not found” alone wastes a retry; (d) prefer `anchor` (a unique nearby string the agent can verify) over line numbers for disambiguation; (e) make every error message self-contained — assume the agent will not remember why things are designed the way they are (atomicity, normalization stages, etc.).
- Run `mise pi-check` before committing. `mise check` includes it.

### Runtime: Node, not Bun

Pi extensions run in **Node.js**, not Bun. Tests run under `bun test`. This mismatch is a trap:

- **No Bun APIs in extension code.** `Bun.spawn`, `Bun.file`, `Bun.write`, etc. will throw `ReferenceError` at runtime but pass in tests. Use `node:child_process`, `node:fs`, etc. instead.
- **Bun-only test APIs are fine.** `bun:test`, `Bun.spawn` in test files only — these never run in pi.
- If spawning processes from extensions, use `child_process.execFile` or `child_process.spawn` from `node:child_process`.

## TUI API notes

Read the `.d.ts` files for actual APIs — don't guess method names. Use LSP (go-to-definition, hover) on imports from `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` to explore available types and methods.

### Key types (from `@earendil-works/pi-coding-agent`)

- `ExtensionAPI` — the `pi` parameter passed to the extension factory. Has `registerCommand`, `registerTool`, `on`, `registerProvider`, etc.
- `ExtensionContext` — the `ctx` parameter in event handlers and command handlers. Has `ui`, `modelRegistry`, `sessionManager`, `model`, `cwd`, etc.
- `ExtensionUIContext` — `ctx.ui` separately. Use when a helper only needs UI methods. Has `select`, `confirm`, `input`, `notify`, `custom`, `setStatus`, `theme`, etc.
- `Theme` — theming object with `fg(color, text)`, `bold(text)`, `dim(text)`, etc. Color names: `"accent"`, `"muted"`, `"dim"`, `"success"`, `"warning"`, `"error"`, etc.

**Writing to the session:** `ctx.sessionManager` is **read-only** (typed `ReadonlySessionManager` — a `Pick` of query methods like `getBranch`/`getEntries`; `appendCustomEntry` is NOT on it). To persist state, use `pi.appendEntry(customType, data)` on the `pi` factory param — writes a `custom` session entry that does NOT participate in LLM context. There is no writable session manager handle exposed to extensions; all writes go through `pi.appendEntry` / `pi.setSessionName` / `pi.setLabel`.

### UI methods (`ctx.ui.*`)

- `ctx.ui.custom<T>(factory)` — show a custom keyboard-focused component. Factory receives `(tui, theme, keybindings, done)`. Return an object with `render(width)`, `invalidate()`, `handleInput(data)`. `done(result)` dismisses it. The component can be a flat object (no Container needed) or a class.
- `ctx.ui.setStatus(key, text)` — add/update a footer status pill. Pass `undefined` as text to remove. Use `ctx.ui.theme.fg("muted", text)` for styling. Keys are unique per extension: `"sidecar"`, `"web-search"`, `"draft"`, `"lsp"`.
- `ctx.ui.notify(message, type)` — show a toast notification. Types: `"info"`, `"warning"`, `"error"`.
- `ctx.ui.select(title, options)`, `ctx.ui.confirm(title, message)`, `ctx.ui.input(title, placeholder)` — simple dialog methods for non-complex interactions.

### pi-tui components (from `@earendil-works/pi-tui`)

- `Input` — single-line text input. Full Component with `render(width)` and `handleInput(data)`. Methods: `getValue()`, `setValue()`. Use directly inside `ctx.ui.custom()` for search boxes instead of hand-rolling filter state.
- `SelectList` — scrollable selection list. `getSelectedItem()`, `onSelect`, `onCancel`, `setSelectedIndex()`. Note: `setFilter` only matches `value` with `startsWith` — for fuzzy search, use `fuzzyFilter` instead.
- `Text` — static text display. `setText()`. Constructor: `(text?, paddingLeft?, paddingTop?)`.
- `Container` — vertical layout container. `addChild()`, `removeChild()`, `clear()`.
- `Spacer` — vertical spacer. Constructor: `(lines?)`.
- `DynamicBorder` — from `@earendil-works/pi-coding-agent` (not pi-tui). Horizontal border that adjusts to viewport width.

### Keyboard handling

- `Key` — helper for typed key identifiers. `Key.enter`, `Key.escape`, `Key.ctrl("a")`, `Key.alt("up")`, etc. Always prefer this over raw string matching.
- `matchesKey(data, keyId)` — check if raw input matches a key. Use with `Key.*` helpers.
- `getKeybindings()` — returns `KeybindingsManager`. Use `kb.matches(data, "tui.select.up")` for navigation keys — this respects user keybinding overrides. Available binding names: `tui.select.up/down/pageUp/pageDown/confirm/cancel`, `tui.editor.*`.
- `fuzzyFilter(items, query, getText)` — fuzzy-match and sort items by relevance. Much better than `SelectList.setFilter` or custom `includes`/`startsWith` matching.

### Patterns to follow

- **Look at existing extensions** before building new UIs. `sidecar/` has a two-screen custom UI with search and toggle (similar to `/scoped-models`). `permission-gate/` has a confirm dialog with diff preview. `web-search/` has tool registration and status. `draft-suggestion/` has widgets and footer status.
- **Use `ctx.ui.custom()` for complex UIs**, `ctx.ui.select/confirm/input` for simple ones. Don't build a custom component for a single yes/no question.
- **Prefer `Input` + `fuzzyFilter` over `SelectList`** for searchable model/option lists. `SelectList.setFilter` is too limited for human-friendly search.
- **Use `ExtensionContext` as the type for `ctx`** in helper functions, not ad-hoc inline types. Import from `@earendil-works/pi-coding-agent`. `ExtensionContext` has `signal: AbortSignal | undefined` for cancelling async work in event handlers.
- **Footer status is cheap** — use `ctx.ui.setStatus(key, text)` to show extension state. Update on `session_start` and after any config changes.
- **Check `extensions/shared/` before building new UI components or utility logic.** It has reusable modules that multiple extensions share. When two extensions need the same logic, extract it here (no `index.ts` = not discovered as an extension). Keep shared code generic and reusable.
