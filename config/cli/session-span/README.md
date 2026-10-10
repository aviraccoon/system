# session-span CLI

Measure how long pi sessions actually ran, and how much of that time was unattended, as input for time entries, for you or any agent with shell access. Runs on bun, no runtime dependencies.

## What it does

pi writes one JSONL log per conversation under `~/.pi/agent/sessions/<cwd-mangled>/<opened>_<id>.jsonl`; a conversation can rotate into a new file after compaction, replaying the earlier rows. The CLI reads those logs — only timestamps, counts, durations, and paths (cwd, session files) ever leave them, never message content — unions a conversation's files, and reports per conversation:

| Field | Meaning |
|---|---|
| first / last | local and UTC |
| file | every log file the report read |
| span / active | in decimal minutes and `H:MM`; active = span − idle, with idle in decimal minutes |
| messages | assistant and user row counts (a rough shape of how much steering the session took) |
| last row | minutes since the last row was written — small means it was written recently |
| gaps ≥ `--report` | classified `work` (an operation or answered tool call covers it), `idle` (unexplained and ≥ `--idle`), or `unknown` (unexplained and below `--idle`), each with the rows bounding it: `assistant → user` is typically a human pause, `user → assistant` a model reply, and non-message rows show their type |
| totals | sessions, span, active, idle — a summary line when the report covers more than one, always in JSON |

A duration on the row after a gap covers that gap; a duration recorded before it does not. A tool call the previous row emitted covers the gap when the row after it answers the call.

## Usage

```bash
session-span --project <session-dir fragment> [--date today|YYYY-MM-DD] [--since <t>] [--until <t>]
             [--file path]... [--session-dir dir] [--idle minutes] [--report minutes] [--json]
```

| Flag | Default | Meaning |
|---|---|---|
| `--project` | — | only session dirs whose name contains the fragment (case-insensitive) |
| `--date` | today | local day to report; session files stamped the neighbouring UTC days are read too |
| `--file` | — | explicit log file, repeatable; skips discovery |
| `--session-dir` | `$PI_SESSION_DIR` or `~/.pi/agent/sessions` | sessions root |
| `--idle` | 15 | gap length in minutes that counts as idle |
| `--report` | 5 | shortest gap listed |
| `--since` / `--until` | — | keep rows only inside this window: `HH:MM[:SS]` on the report day, or `YYYY-MM-DDTHH:MM[:SS]`; the window is read in the report's zone |
| `--json` | off | machine-readable output |

```bash
session-span --project acme --date today            # today's sessions in that tree
session-span --file ~/.pi/agent/sessions/x/y.jsonl  # one explicit file
session-span --file ~/.pi/agent/sessions/x/y.jsonl --since 09:30 --until 10:30   # one thread's window
```

With `--file`, the day filter applies only when `--date` is given (including `--date today`);
without it the files are reported as-is. Pass every file of a rotated lineage explicitly — the
CLI reads only the files it is given.

The report is the measurement only: the size follows from the active minutes and your own
judgement.

Exit codes: `0` reported; `1` nothing to report (for the day, or in the given files) or an error, named in the message. An unknown session format fails loudly instead of reporting wrong numbers.

## Development

```bash
mise tree-check config/cli/session-span   # tsc + bun test (lint via `mise check`)
bun run session-span.ts --help   # without the symlink
```
