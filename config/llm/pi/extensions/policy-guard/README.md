# policy-guard

Refuses a tool call that breaks a project's policy: a command, a file write, a fetch or a dispatch that a clause in the project's file forbids.

The policy is prose, per project, at `~/notes/llm/<project>/.agents/policy.json`.
No command list lives in this extension and nothing here parses a shell. A
decision model reads one call against the project's clauses, one question per
clause, and the threshold that turns an answer into a refusal is a number in the
file. That is what lets the guard tell a dependency install apart from a
packaging step, or a budgeted run from an unbounded one, without a rule for
every shape.

## Policy file

```json
{
  "project": "acme-widgets",
  "binding": {
    "command": "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    "workdir": "/workspaces/acme-widgets/app"
  },
  "clauses": [
    {
      "id": "deps",
      "text": "Dependency work runs in the devcontainer.",
      "criteria": {
        "true": "The call installs dependencies outside the devcontainer.",
        "false": "The call runs no dependency install, or runs it in the devcontainer."
      }
    },
    {
      "id": "e2e",
      "text": "Browser end-to-end suites run on the host.",
      "criteria": {
        "true": "The call runs a browser suite somewhere other than the host.",
        "false": "The call runs no browser suite, or runs it on the host."
      }
    },
    { "id": "budget", "text": "A long run carries a timeout budgeted from a measured run.", "threshold": 0.8 }
  ],
  "precedence": "The e2e clause is the only exception to the deps clause."
}
```

`binding` is optional and is the one machine fact a policy may add: the command
prefix that reaches the environment its clauses name. `command` is everything
before the command string, `workdir` is the directory inside the environment that
the host checkout mirrors, and `shell` is the prefix that turns a command string
into one argv (`sh -lc` when absent, `bash -lc` or `sh -c` for an environment
that wants another). A policy with no binding is judged on its clauses alone.

Clauses are prose, and each one is asked separately, so a wrong verdict names the
clause that caused it. `criteria` is what counts as breaking the clause, and it is the
author's to write: only they know whether the clause requires work or allows it, and the
neutral pair used when it is absent reads a permission as a requirement. `/guard status`
names the clauses running on that default. `threshold` overrides the policy default for
one clause, for a rule that should refuse earlier or later than the rest. `precedence` is
for clauses that collide; it rides every question, because the clauses are judged
independently and a clause that allows work another forbids is only visible to the model
if it sees both.

Every entry the parser drops is reported, and any error leaves the guard
inactive rather than running on part of a policy. `/guard status` shows the
path, the project, the clause count and every error.

The rules also reach the agent directly: the first turn of a session carries the
clause list, generated from the policy file, opened with what the guard is and
closed with where the rules live. The block is carried again whenever the copy in the
context is not the current rendering, and a copy sent beside one that is still visible is
marked as the current one: it says it supersedes the earlier copy. A project with no
policy file gets no block; the floor on that file is the only rule that still applies
there.

## Behaviour

- **Refusal**: a blocked call, naming the clause that fired and quoting it, the
  policy file with its clause count, and the grant line. Nothing is derived from
  the call itself: with clauses on any axis, a sentence about the input would need
  one per clause, and the agent already has the clause in context. Nothing
  auto-allows a refusal and there is no per-call dialog; the unlocks are the
  user-typed `/guard allow` (host work, `bash` only) and `/guard off`.
- **The refusal names the unlock that works for the call**: `/guard allow` for a
  shell call, `/guard off` for anything else, because a host grant does not cover a
  write, a fetch or a dispatch.
- **Every tool call is judged**, not just `bash`: the call summary carries the
  command, the resolved target paths, a url, a search query or a dispatch's task,
  whichever the tool named. A call that names none of them is skipped, because no
  clause can act on a bare tool name and a request per call is paid for by every
  session. A host grant covers `bash` only.
- **The policy is the user's to write**: an edit-like call whose target resolves to
  a `.agents/policy.json` is refused, whatever the session was granted and
  whether or not the file parses. A shell command naming the file is refused too,
  read or write, because telling those apart means parsing shell; its refusal points
  at the read tool instead.
- **No policy file**: the guard refuses nothing except a call that names a
  `.agents/policy.json`, and a project that wants the rest writes the file.
- **Reading guidance, not a rule**: the question tells the judge that a wrapper, a
  chain or a pipeline does not change what its parts do, and that a command
  touching nothing the project owns is not project work. It says nothing about
  where work runs, because a sentence that clears a container call also clears
  every clause on another axis.
- **Failures are loud, and mostly open**: an unavailable judge, an incomplete
  answer, a missing credential or an unreadable policy notifies the user once and
  lets the call through, because blocking every call during a classifier outage
  costs more than the report does.
- **Verdicts are cached** per call for the session, so a retried call is not
  re-judged. A judge failure is not cached.

## Commands

| Command | Effect |
|---|---|
| `/guard status` | Policy path, project, clause count, the clauses on the default criteria and the ones no refusal has cited this session, state, judge and errors |
| `/guard allow` | Grant host work for this session |
| `/guard revoke` | Take the grant back |
| `/guard off` / `/guard on` | Turn policy checks off or on for this session |

## Tool

`policy` (read-only, no arguments) is the agent's view of the guard: either the
rules with their clause ids, precedence and binding, or the policy path with its
parse errors; the session state (granted or off); and the newest calls the guard has
judged in this session, each with the clause it broke (an allowed call has none).

## Decision log

`~/.pi/agent/state/policy-guard.log` holds one JSON line per call the guard judged or
refused, tagged with the session id: allowed calls included, and a call is not
re-judged while its verdict is cached. It is the record of the verdict probability and
the clause that fired; the tool's view never renders a number. `session_start` trims the
file to its newest `FILE_LIMIT` lines, so the oldest records are dropped.

## Configuration

| Variable | Default |
|---|---|
| `PI_GUARD_MODEL` | `DEFAULT_DECISIONS_MODEL`, the pin in `../shared/decisions.ts` |
| `PI_GUARD_PROVIDER` | `openrouter` |
| `PI_GUARD_THRESHOLD` | `0.65` |
| `PI_GUARD_TIMEOUT_MS` | `10000` |

The questions, the clause rendering and the refusal derivation are in
`../shared/policy.ts`. The threshold is a starting point calibrated with
`benchmarks/policy.ts`, which also measures a clause on an axis other than where
work runs, and whether the policy questions change any of the risk battery's
answers when both ride one request.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Activation, the `tool_call` floor, `/guard` |
| `policy-file.ts` | Parser and validator for `policy.json` |
| `policy-source.ts` | Stat-gated policy loading, with the change signal that drops cached verdicts |
| `numbers.ts` | Validated `PI_GUARD_THRESHOLD` / `PI_GUARD_TIMEOUT_MS` with the warning lines for bad values |
| `decisions.ts` | The decision record and the session-scoped view the tool renders |
| `refusal.ts` | The blocked-call text |
