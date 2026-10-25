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
reuse the previous verdict — useful for repeated test/lint/build commands. For
edit-like calls the key includes the previewed state (create vs overwrite, the
added lines), so a create verdict is never reused for an overwrite.

Parse failures and sidecar failures both fall through to the dialog — a failed
parse never auto-allows, and a dead sidecar just means the user confirms.

### Classifier

The confirm dialog and auto-classify share one classifier. A decisions model
answers a battery of independent yes/no risk factors and the verdict comes from
thresholds in code — the factors and policy live in `shared/risk-factors.ts`,
shared with the benchmarks that measure them. A severity `score` rides the same
request: a call scored above 2.5 (past serious harm) is dangerous even when no
dangerous factor fired. Shell calls answer two more questions on the same
request: output-capture and the patch reminder. The output-capture advisory blocks
a long diagnostic (tests, build, typecheck gate) whose output is only filtered or
discarded, with a capture rewrite, when it would have been auto-allowed. The
patch reminder appends a note to the tool result when the call rewrote an
existing file through the shell instead of the `patch` tool — an inline
interpreter script, `tee`, a redirect over the file — unless the file is out of
the edit tools' reach (`docker exec`, `ssh`, `kubectl exec`), or the call created
a new file (a heredoc-written script included), ran a formatter or other bulk
transform the edit tools cannot reproduce, wrote scratch or generated output, or
only read. Both scores ride the classification entry. edit-guard still blocks the
two shapes it can see in the command text (`sed -i`, `perl -i`); the question
covers what a pattern list cannot. The `explain` role still writes the human
sentence; both run in parallel, so the dialog shows the sentence and the fired
factors with their probabilities on one line, and `Ctrl+E` adds the
factor list against the thresholds plus the longer explanation.

The state a classifier reads is a header plus an excerpt of what the call writes. The
header names the tool and path and, for edit-like calls, the shape of the change
(`creates a new file: 4 lines`, `overwrites the existing file: removes 40 lines, adds
2 lines`); it is never truncated. For `bash` the excerpt is the command, and for
`subagent` the task text (one `agent: task` line per step); both are preceded by the
call's remaining options as a JSON line after the header, as are `write`, `edit` and
`patch`. Excerpt and options are clipped at 100K characters. For `write`, `edit` and `patch` it is
the added lines, also clipped, and removed target text never reaches the classifier:
removals arrive as a count, taken from the preview summary or counted from the edit
itself when there is no preview. Any other tool is described by its input JSON,
clipped to 500 characters. Each classified call appends a `classified` session entry
(verdict, factor scores, detail) for threshold tuning.

### Facts about the call

A command says what runs, not what it reaches. Before classifying a `bash` call
the gate appends facts collected from the machine: when a command names a running
container, that container is inspected and the state gains what it mounts, whether
it is privileged, and its image, status and network. Damage confined to a
container's own writable layer is then risky rather than dangerous, because the
container goes away with its layer; a bind mount, a volume, a socket or a
privileged container keeps the dangerous tier.

Which container a command names is answered by the runtime's own list and a word
match — container name, id, or compose service — so wrappers, `sh -c` payloads and
`docker compose exec` resolve without a shell grammar. The container facts count
only when the block is present: a container that is not running or could not be
inspected leaves the stricter tier, and the block is generated text, so a command
cannot claim locality for itself. A command that names `ssh` or `kubectl` as a word
gets no container facts at all, since the container it names may live on the other
machine.

When the decisions call fails, the provider has no credential, or any factor or
the severity score is missing, the verdict comes from the `explain` role alone —
the display degrades, never the fail-closed behavior. The model is pinned in
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
  classification, tirith's findings). Each message carries a `[note on the <tool> call:
  <command or path>]` attribution, since one turn can queue several calls.

### Diff preview

For `edit` and `write` tool calls, the dialog shows a unified diff computed from
the pending changes; `write` reads the target first, so an overwrite shows its
removals instead of only the new content. For `edit`, matching comes from the
vendored matcher in `edit-match.ts` (pi's own isn't exported) with rendering from
`generateDiffString`.
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

When [`tirith`](https://github.com/sheeki03/tirith) is on PATH, the gate asks it about
every bash command. It is a witness, not a judge: tirith looks up the packages, hosts
and text a command carries against curated threat lists and encoding checks, and its
findings go to the classifier as evidence, in words that say what tirith is and what it
found. The classifier then weighs them with everything else — a prefix rule never
inspects a package name or a URL, so a name on the OSSF malicious list would otherwise
pass unseen.

Its own tiers are not reused as policy. One rule id can cover both an attack and an
ordinary shape (`curl_pipe_shell` fires on `curl | bash` and on `curl | python3 -c
'import json'`), the catalogue publishes no per-rule action, and the action it does
report follows tirith's config — so a rule list here would be a second policy that goes
stale on every release.

One exception, because no dialog helps a user weigh it: a finding tirith rates
**CRITICAL** — a confirmed malware row, a bidi or Unicode-tag concealment — is never the
classifier's to resolve. It forces the confirm path, which is a refusal when there is no
UI to ask, and the dialog shows the findings at the top. A block that carries no finding,
or a finding with no severity to read, takes the same path.

- **Banner:** the findings appear warning-coloured above the explanation. The banner
  reports rather than decides; only a CRITICAL finding or a findingless block can be the
  reason a dialog opens.
- **A call that never reaches the classifier:** the gate's own allow rules and a dialog
  the user allows both skip it, so the findings go to the model as a result note —
  otherwise a sub-CRITICAL finding would be invisible to it. A classifier auto-allow keeps
  the finding with the classifier, which is where it was weighed.
- **Degradation:** tirith missing → no findings; tirith error or timeout → no findings
  (the confirm flow is the backstop).
- **Hot path:** `TIRITH_LOG=0` (pi already logs tool calls). tirith is not run
  offline: its 24h background DB refresh is what keeps the threat database current,
  the frequent bash checks are what trigger it, and nothing else runs tirith, so
  offline would go stale. `check`'s package detection is local-DB-only either way;
  live registry signals need `tirith package risk --online`. Reports are cached per
  session.

Status bar shows `+tirith` when active.

## Files

- `logic.ts` — Pure decision engine, no pi dependencies
- `logic.test.ts` — Tests for decision logic and auto-classify helpers
- `explain.ts` — Verdict parsing, tool call description, block reasons
- `explain.test.ts` — Tests for explain/verdict logic
- `prompts.ts` — Explain role system prompt, shared with the benchmarks
- `edit-preview.ts` — Real diff and change summary for write/edit calls, used by the dialog and the classifier
- `edit-match.ts` — Edit matcher vendored from pi, so previews match what the edit will do
- `tirith.ts` — tirith report parsing, the CRITICAL floor and the classifier-facing fact
- `facts.ts` — Facts collected from the machine for the classifier state (`docker inspect` for a container the command names)
- `facts.test.ts` — Tests for command detection, inspect parsing, the rendered block and the collector
- `result-notes.ts` — Resolves a result's note (staged text plus an in-flight classification), with no pi imports
- `confirm-ui.ts` — Custom TUI component (SelectList + Editor note field + explanation display)
- `index.ts` — Pi extension wrapper (UI, events, auto-classify, user-message notes, tool_result note injection)

## Known limitations

- Trust project mode still confirms all bash (scoping commands to dirs is unreliable).
- Cross-extension imports work via `../shared/` but keep extension-specific logic local.
- No mouse/scroll wheel support (pi TUI is keyboard-only).

## Testing

```bash
bun test extensions/permission-gate/
```
