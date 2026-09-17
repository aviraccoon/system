# Subagent Extension

Delegate tasks to specialized agents with isolated context windows. Spawns a separate `pi --mode rpc` process for each invocation, communicating via bidirectional JSONL.

## What it does

1. **`subagent` tool** — the LLM can delegate research, code investigation, or other tasks to agents defined in `~/.pi/agent/agents/*.md` (user-level) and `.pi/agents/*.md` (project-level)
2. **Three modes** — single (`agent` + `task`), parallel (`tasks` array, up to 8 tasks, 4 concurrent), and chain (`chain` array with `{previous}` placeholder for sequential handoffs)
3. **Streaming output** — in single mode, text, thinking, and tool calls appear live in the TUI during execution in exact arrival order. Chain/parallel show completion status only (see Known limitations)
4. **Agent discovery** — `.md` files with YAML frontmatter define agent name, description, tools, role, extensions, and system prompt
5. **Model roles** — agent frontmatter `role` field resolves to a model from `roles.json` via the shared `model-roles` module
6. **Per-agent extensions** — subagents load with `--no-extensions` (no auto-discovery) and get `agents-loader` + `permission-gate` always, plus any extensions in the agent's `extensions` frontmatter field
7. **Session storage** — each run writes a JSONL session to `~/.pi/agent/subagent-sessions/`, cleaned up after 7 days
8. **Project-local agent gating** — prompts for confirmation before running agents from `.pi/agents/` in the project repo

## Commands

- `/subagent-toggle` or `Ctrl+Shift+S` — enable/disable the `subagent` tool
- `/subagent-status` — list available agent definitions, their tools/roles, and configured model roles
- `/subagent-steer` or `Ctrl+Shift+T` — send a steering message to a running subagent (see Steering below)

## Agent definitions

Agents are `.md` files with YAML frontmatter:

```markdown
---
name: researcher
description: Investigate codebases, read files, search patterns, return structured findings
role: explain
tools: read,grep,find,ls,web_search,web_fetch
extensions: web-search
---
System prompt body goes here...
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Agent identifier used in `agent`/`tasks`/`chain` params |
| `description` | yes | One-line summary shown in tool description and status |
| `tools` | no | Comma-separated tool allowlist. Defaults to built-in tools if omitted |
| `role` | no | Resolves to a model chain from `roles.json` (e.g., `explain` → local sidecar model) |
| `extensions` | no | Comma-separated extension names to load. Resolved from `~/.pi/agent/extensions/<name>/` |

### Discovery

- **User agents**: `~/.pi/agent/agents/*.md` — always available (deployed by Nix via symlink from `config/llm/pi/agents/`)
- **Project agents**: `.pi/agents/*.md` — requires `agentScope: "both"` or `"project"` param, plus user confirmation
- When both define an agent with the same name, project takes precedence (with `agentScope: "both"`)

## How it works

### RPC execution

Each subagent invocation:

1. Resolves the agent's model from `roles.json` (via `role` field) or falls back to the session's current model
2. Writes the agent's system prompt to a temp file
3. Spawns `pi --mode rpc --no-extensions --session-dir <dir> --append-system-prompt <file>`
4. Sets `PI_SUBAGENT=1` to suppress journal injection and other interactive features
5. Sends a `prompt` RPC command with the task
6. Processes streaming events (`message_update`, `tool_execution_start/end`, `agent_end`)
7. Shuts down by closing stdin after an `abort` (pi has no `shutdown` RPC command), which makes the child exit 0 cleanly; SIGTERM/SIGKILL only as a 3s escalation fallback

### Streaming

Text deltas, thinking blocks, and tool calls from the subagent are interleaved in the TUI output in their exact arrival order (an ordered event log rebuilt on each update). Thinking renders in italic with the theme's `thinkingText` color, distinct from output text. The full content array is rebuilt on each update (not incremental — the TUI replaces, not accumulates).

Footer status shows live counters during execution (`[events:N updates:N] <preview>`) in single mode.

### Result display

Assistant messages are grouped into turns (one per assistant message). Commands from the known tools (bash/read/write/edit/patch/ls/find/grep) are always shown in full — no truncation. Unknown tools show a 50-char JSON args preview.

- **Collapsed** (default, single mode): the last 3 turns' commands, a preview of the final output, usage, and a `(Ctrl+O to expand)` hint whenever anything is hidden (earlier turns, longer output, thinking, intermediate text).
- **Expanded** (`Ctrl+O`): every turn — thinking, text, and commands — plus the task and usage. The task in the call view is also only shown in full when expanded.
- **Streaming** (live, single mode): `Ctrl+O` works mid-run too. Collapsed live view caps thinking to its last line and text to the last few lines (commands stay full); expanded shows the whole feed.

Steering messages sent via `/subagent-steer` appear immediately in the live feed and in the result display as bold `steering: …` lines at the turn boundary they arrived at.

`Ctrl+O` is pi's global `app.tools.expand` toggle; it applies to the last tool output.

### Steering

Send mid-run messages to running subagents via `/subagent-steer` or `Ctrl+Shift+T`:

- **0 active** — notifies "No running subagents"
- **1 active** — opens input dialog directly
- **N active** — picker shows `[#id] agent: task preview...`, then input dialog

The message is delivered via pi's `steer` RPC command, which interrupts the current generation. Uses pi's `steeringMode` setting (default: queues after current tool batch).

### Handle registry

Running subagents are tracked in a module-level `Map<number, HandleEntry>`. Each `runSingleAgent` call registers a handle on spawn and unregisters on completion/abort/error. This works across all modes — single, parallel, and chain each register handles independently.

## Subagent environment

Subagents run with:

- `PI_SUBAGENT=1` — suppresses journal extension, reduces instructions to essentials
- `--no-extensions` — no auto-discovered extensions; loads `agents-loader` + `permission-gate` plus agent-declared ones
- `--session-dir ~/.pi/agent/subagent-sessions/` — isolated session storage
- Tool allowlist from agent frontmatter `tools` field
- **Gate dialogs**: the child's `permission-gate` starts fresh (Careful mode, no grants inherited from the parent), so any gated call blocks in the parent TUI. `bash` confirms unless the agent opts into `sandbox-bash`, which the gate trusts because the OS confines it. The `subagent` tool itself always confirms — that prompt is the delegation veto.
- Same working directory as the parent (or `cwd` param)

### RPC UI behavior

| Method | Works in subagents? | Behavior |
|--------|---------------------|----------|
| `confirm()` | Yes (relayed) | Emitted to parent TUI via relay, response sent back on stdin |
| `select()` | Yes (relayed) | Same as confirm |
| `input()` | Yes (relayed) | Same as confirm |
| `custom()` | No (returns undefined) | No-op in RPC mode — crashes callers that expect a result |
| `notify()` | Yes | Fire-and-forget RPC event |
| `setStatus()` | Yes | Fire-and-forget RPC event |

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension wiring: tool registration, execute dispatch (single/parallel/chain), toggle and status commands |
| `agents.ts` | Agent discovery, frontmatter parsing, directory scanning. Pure fs/path, no pi deps |
| `rpc.ts` | RPC process management, streaming state machine, event loop, `SubagentHandle`, model resolution |
| `render.ts` | TUI rendering: `renderCall`/`renderResult` for tool call display and streaming output |
| `agents.test.ts` | Tests for frontmatter parsing, discovery, project directory resolution (19 tests) |
| `render.test.ts` | Tests for formatting and render output (38 tests) |

## Known limitations

- **RPC shutdown**: pi has no `shutdown` command, so the extension closes stdin after an `abort` for a clean exit 0, with SIGTERM/SIGKILL as a 3s escalation fallback. User abort uses a 5s SIGTERM/SIGKILL timeout.
- **`custom()` in subagents**: extensions using `ctx.ui.custom()` will crash in subagent mode (returns undefined). The permission gate uses `confirm()`/`select()`/`input()` instead, which are relayed to the parent TUI.
- **Parallel/chain modes**: implemented but not heavily tested beyond basic scenarios.
- **No live streaming in chain/parallel**: `onUpdate` forwarding is swallowed while a step is running, so chain/parallel only show completion status (`Parallel: X/Y done…`), not the interleaved live feed. `Ctrl+O` mid-run works in parallel (completed agents render full turns, running ones show `(running...)`), but the collapsed live-view caps don't apply — there's no live view to cap.
