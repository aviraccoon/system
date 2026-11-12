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
parse errors; the session state (granted or off); and the newest judged calls and unlocks
in this session, each with the clause it broke (an allowed call and an unlock have none).

## Decision log

`~/.pi/agent/state/policy-guard.log` holds one JSON line per judged or refused call,
tagged with the session id and the project: allowed calls included, and a call is not
re-judged while its verdict is cached. Each line carries the verdict probability, the
clause that fired, every answered clause's probability, the clauses the judge left
unanswered, and the tool the call used. A `/guard allow` and a `/guard off` are recorded
too, as the mark that a refusal was overridden (see Calibration); their line carries the
surface the unlock covers. The tool's view never renders a number. `session_start` trims the
file to its newest `FILE_LIMIT` lines.

## Calibration

```bash
bun run extensions/policy-guard/calibrate.ts                    # from the decision log
BENCH_DUMP=/tmp/dump.jsonl bun run benchmarks/policy.ts         # labeled synthetic cases
bun run extensions/policy-guard/calibrate.ts --bench --policy short /tmp/dump.jsonl
bun run extensions/policy-guard/calibrate.ts --project acme-widgets
```

A threshold is fitted per clause: every refusal that **stood** must score above it and
every **overridden** one below it, and the suggestion is the unrounded midpoint, printed to
three decimals. The print separates the classes only while the gap between them exceeds a
thousandth; a narrower gap needs the number widened by hand before it is pasted. Neither label
is ground truth, since the log records what the judge said and not whether it was right, so each
refusal's label comes from what happened next in its session: an unlock within ten minutes marks
it overridden, a next call the judge cleared marks it stood. Only an unlock that covers the
refused surface counts, because `/guard allow` is a host grant for `bash` while `/guard off`
covers every tool. A refusal whose verdict came from part of the policy (the judge did not answer
every clause) is not labeled at all. An unlock lasts for the rest of the session, so it can
override a later refusal rather than the one before it, and a cleared call need not be related to
the refused work; the report names the label it used, not "right" or "wrong". A clause with
fewer than five labels of either class, or whose classes overlap, gets no suggestion and the
reason why.

The log is shared by every project, and a clause id means a different rule in each, so a
fit reads one project's records: `--project <name>` picks it when the log carries several.
A record with no project name is not fitted.

The benchmark dump is the labeled set, its cases written by hand, so `stood` and
`overridden` there are the labels a case was written with rather than session
observations, and the report says so under the table. A dump carries several policies over
the same cases, so name one: `calibrate.ts --bench --policy short <dump>`.

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
| `calibrate.ts` | Fits a per-clause threshold from the decision log or a benchmark dump |
