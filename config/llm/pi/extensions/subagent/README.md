# Subagent

Runs a task in a separate `pi` process with its own context window, and returns the answer through
one tool result, or with `background` a run id whose answer arrives later. The child reads, searches
and runs tools on its own, and its permission gate never opens a dialog.

## What you need

- pi with this extension loaded. `pi.nix` symlinks every extension directory into
  `~/.pi/agent/extensions/`, and `/reload` applies an edit.
- Provider credentials the child can use. A dispatch resolves the `subagent` role from `roles.json`
  unless its agent pins a model or names a role; with no `subagent` role either, the child runs pi's
  own default model.
- An agent definition, or an inline `spec` for a one-off worker.

## Agents

An agent is a `.md` file: YAML frontmatter and a system prompt body.

```markdown
---
name: log-auditor
description: Read a service's logs and report each error with its timestamp
tools: read,grep,find,ls
extensions: web-search
---
Read the logs under the directory you are given and report every error with its timestamp and
source line.
```

`name` and `description` are required. `tools` and `extensions` are comma-separated lists, `model`
pins a `provider/model-id`, `role` names a chain in `roles.json`, and `thinking` sets a level
(`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

Definitions load from these roots, lowest precedence first:

1. `~/.pi/agent/agents/`
2. `<repo>/.agents/agents/` and `<repo>/.pi/agents/`
3. `<notes>/<project>/.agents/agents/` and `<notes>/<project>/.pi/agents/`

A file in a later root overrides an earlier one with the same name, and `.pi/agents` overrides
`.agents/agents` at the same root. Repo roots load only for a dispatch that passes
`agentScope: "both"` (or `"project"`) in a trusted project, and in an interactive session only
after a once-per-repository confirmation. A run with no UI loads them without asking. Notes agents
load always.

## First dispatch

Save the agent as `~/.pi/agent/agents/log-auditor.md`, then dispatch a task with a journal you have:

```json
{
  "agent": "log-auditor",
  "task": "List every error in logs/ and the file each one came from.",
  "journal": "~/notes/llm/acme"
}
```

`journal` takes a journal directory or one entry file, and the child's task starts with a line
telling it to read that record. `journal: "none"` dispatches blind, for a review that must not read
the journal; leaving it out makes edit-guard refuse the call unless each task names the journal path
itself.

The result carries the child's final answer, its usage counters, and the path to its session file
under `~/.pi/agent/subagent-sessions/`.

## One-off worker

A dispatch that needs no agent file carries the child's instructions instead:

```json
{
  "spec": {
    "instructions": "Check a change against its task and report only the gaps, quoting the code.",
    "bash": "sandboxed"
  },
  "task": "Check src/parser.ts for tests that cannot fail.",
  "journal": "~/notes/llm/acme"
}
```

`spec` takes two fields and refuses anything else by name: a worker may not name a model, a role, a
tool allowlist or an extra extension. `bash` is the one capability the dispatch chooses, and it can
only add the sandbox.

- `instructions` is the worker's system prompt.
- `bash` picks the shell. `"sandboxed"` (default) runs the kernel-confined shell: reads almost
  anywhere (most dot-entries under `$HOME` and credential paths are denied), writes only to the
  temp directory, no network. `"normal"` keeps the built-in shell; the gate decides what runs, and
  under its default mode that is nothing.

A worker is single mode only: pass `task` and no `agent`, `tasks` or `chain`. Its model comes from
the `subagent` role; with no such role, pi's default. It loads the gate and `agents-loader` like
every child, and it gets the built-in tool set, so, unlike an agent file, it cannot narrow them.

## Background runs

`background: true` on a single-mode dispatch returns a run id instead of the answer. The completion
arrives as a message when the run settles, or when your turn ends if that is later. `subagent_wait`
collects it early and drops that message; it takes ids or none, defaults to 30s, and a timeout returns
the current state rather than an error. `subagent_close` stops a run. The run's record and output sit
in `/jobs` beside shell jobs.

A background run is not killed when your turn is interrupted; it ends with the session or a
`/reload`, or when `subagent_close` names it. Five at once is refused.

Run ids start with `s-`; shell job ids start with `j-`.

## Limits

- A call the gate would ask about is refused instead, and a sandboxed shell is bounded by its
  kernel profile rather than judged. [`../permission-gate/README.md`](../permission-gate/README.md)
  says what it refuses.
- Only `confirm`, `select` and `input` dialogs from another extension reach you; `custom()` is
  unavailable and `editor()` is cancelled.
- Parallel runs report `N/M done` while they work; only single mode streams the child's live output.
  A one-item `tasks` batch runs as single; a blank agent or task keeps it parallel.
- Parallel runs take up to 8 tasks, 4 at a time.
- A sandboxed shell cannot write in the child's worktree, so a child that must create files there
  uses its file tools. Where the profile fails to load, the built-in shell stays and the gate judges
  it.
- A provider failure gets up to three attempts across the agent's model chain, but only when the
  attempt produced no answer; a delivered answer is kept, and a retry repeats the whole task.
- A run aborts at `maxTurns` (default 30). With room before the cap, one steering message three turns
  ahead asks the child to write its report.
- A `cwd` that does not exist fails the dispatch instead of falling back to the parent's.
- Session files under `~/.pi/agent/subagent-sessions/` are deleted after 7 days.

## Commands

- `/subagent-toggle` or `Ctrl+Shift+S` disables the tool for the session.
- `/subagent-status` lists every definition with its tools and resolved model target.
- `/subagent-steer` or `Ctrl+Shift+T` sends a message to a running child.

## Where to go next

- [`../permission-gate/README.md`](../permission-gate/README.md): the `scoped` band, sensitive
  paths, and what a refused child gets back.
- [`../sandbox-bash/README.md`](../sandbox-bash/README.md): the profile's writable roots and the
  load-time boundary check.
- [`../../README.md`](../../README.md): every extension in this tree.
