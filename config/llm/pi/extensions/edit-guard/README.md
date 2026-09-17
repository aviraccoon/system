# edit-guard

Deterministic content-policy checks on files the agent edits. When a written
rule ("TODO.md has no done items", "no journal references in public code")
keeps losing to the agent's training gravity, mirror it here as line patterns
instead of hoping the prompt sticks.

## How it works

- On every `write`/`edit`/`patch` tool result, each touched file is scanned
  with the rules whose matcher accepts it. Violations are appended to the
  tool result as a self-contained block: matched lines with `>>` context plus
  the verbatim policy statement. The agent can correct immediately, without
  the user reading diffs.
- Every `bash` command is scanned with `bash`-kind rules before it reaches
  the agent; the same self-contained block is appended to the tool result.
- `write` to an existing non-empty file is blocked once with a pointer to
  `patch` (write is for new files). Re-issuing the same write proceeds, so
  genuine full rewrites stay possible.
- Silent when clean — no "0 violations" noise.
- Files the edit did not change are never scanned; files written through
  `bash` are out of scope (only the command line itself is checked).
- `/todo-check [path]` sweeps the project journal `TODO.md` on demand and
  sends the report to the agent; the `todo_check` tool exposes the same scan
  to the agent itself (wrap-up use: finds stale violations no live edit
  would re-trigger).

## Rules are data

Built-in defaults live in `rules.ts` (`DEFAULT_RULE_CONFIG`). A user config at
`~/.config/llm/edit-guard.json` is merged over them: entries whose
`displayName` matches a default replace that default in place; entries with a
new `displayName` are appended. `displayName` is the rule's identity — it
appears in every message header. Delete the config file to fall back to pure
defaults.

```jsonc
[
  {
    "displayName": "TODO.md",
    "match": { "kind": "basename", "names": ["todo.md"] },
    "policy": "One-sentence self-contained instruction shown with every hit.",
    "patterns": [
      { "label": "DONE marker", "regex": "\\bDONE\\b" },
      { "label": "done tag", "regex": "\\[(?:done|completed)\\]", "flags": "i" }
    ]
  },
  {
    "displayName": "public file",
    "match": { "kind": "allExcept", "paths": ["{notesDir}", "{sessionsDir}", "{cwd}/config/llm"] },
    "policy": "...",
    "patterns": [{ "label": "journal path reference", "regex": "\\bnotes/llm\\b" }]
  }
]
```

- `match.kind: "basename"` — case-insensitive basename set.
- `match.kind: "allExcept"` — every edited file except paths under the listed
  roots; `{notesDir}`, `{sessionsDir}`, `{cwd}` placeholders expand at runtime.
- `match.kind: "bash"` — the rule runs against every shell command instead of
  file contents.
- Broken regexes and an invalid config file are reported as warnings and the
  affected pattern/rule is skipped — a broken rule must never silently stop
  matching.

## Adding a rule

Only add rules with observed violations — a speculative row costs false
positives on every edit of the matched files. The row needs: a matcher (or
`"match": { "kind": "bash" }` for command rules), one or more line patterns,
and a `policy` string that stands alone (the agent reading the tool result
sees only that block).

## Internal codenames

The built-in `internal codename` rule flags comments referencing "the plan"
(agent planning docs). Codenames are unknowable to the defaults — add them as
patterns in `~/.config/llm/edit-guard.json` by appending a rule with the same
shape; it merges over the built-in under its `displayName`:

```jsonc
[
  {
    "displayName": "internal codename",
    "match": { "kind": "allExcept", "paths": ["{notesDir}", "{sessionsDir}", "{cwd}/config/llm", "{cwd}/.pi"] },
    "policy": "Comments must describe the change on their own terms — no internal codenames.",
    "patterns": [
      { "label": "internal plan reference", "regex": "\\bthe plan\\b", "flags": "i" },
      { "label": "internal codename reference", "regex": "\\bproject-clanker\\b", "flags": "i" }
    ]
  }
]
```

Replacing the built-in row by reusing its `displayName` is intentional: your
pattern list fully defines that rule.
