# env-guard

Refuses `bash` calls that break a project's environment policy: dependency,
build, test or dev-server work that the project runs in a container.

The policy is prose, per project, at `~/notes/llm/<project>/.agents/environment.json`.
No command list lives in this extension and nothing here parses a shell. A
decision model reads the command against the project's clauses and answers two
questions: refuse it, and which clause fired. That is what lets the guard tell a
dependency install apart from a packaging step, or a container test run from a
host one, without a rule for every shape.

## Policy file

```json
{
  "project": "acme-widgets",
  "environment": "the devcontainer",
  "binding": {
    "command": "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    "workdir": "/workspaces/acme-widgets/app"
  },
  "clauses": [
    { "id": "deps", "text": "Dependency work runs in the devcontainer." },
    { "id": "e2e", "text": "Browser end-to-end suites run on the host." }
  ],
  "precedence": "The e2e clause is the only exception to the deps clause."
}
```

`binding` is the one project-specific machine fact: it turns a refusal into a
runnable command. Clauses are numbered in the question and cited by `id` in the
refusal, so the reason can be checked against the policy. `precedence` is for
clauses that collide; a policy that contradicts itself produces a judge that
picks a side per call.

Every entry the parser drops is reported, and any error leaves the guard
inactive rather than running on part of a policy. `/guard status` shows the
path, the project, the clause count and every error.

## Behaviour

- **Refusal**: a blocked call, with the clause quoted when the judge names one
  (and said so when it does not), the command to run in the environment instead
  when the binding can wrap the call, and the grant line. Nothing auto-allows a refusal and there is no per-call
  dialog; the only unlocks are the user-typed `/guard allow` and `/guard off`.
- **No policy file**: the guard does nothing, and a project that wants it writes
  the file.
- **Where a command runs** is a reading the judge makes, from the command itself.
  The question tells it that a command whose work runs inside the container does
  not break a container clause, and that a wrapper, a chain or a pipeline does not
  change where its parts run. There is no harness-side recognizer to disagree
  with, and no list of commands that stay transparent.
- **Failures are loud, and mostly open**: an unavailable judge, an incomplete
  answer, a missing credential or an unreadable policy notifies the user once and
  lets the call through, because blocking every bash call during a classifier
  outage costs more than the report does. The citation request is the exception:
  a failure there keeps the refusal and says the clause is missing.
- **Verdicts are cached** per command for the session, so a retried test suite is
  not re-judged. A judge failure is not cached; an uncited refusal is a verdict and
  is.

## Commands

| Command | Effect |
|---|---|
| `/guard status` | Policy path, project, environment, clause count, state, judge and errors |
| `/guard allow` | Grant host work for this session |
| `/guard revoke` | Take the grant back |
| `/guard off` / `/guard on` | Turn policy checks off or on for this session |

## Configuration

| Variable | Default |
|---|---|
| `PI_GUARD_MODEL` | `DEFAULT_DECISIONS_MODEL`, the pin in `../shared/decisions.ts` |
| `PI_GUARD_PROVIDER` | `openrouter` |
| `PI_GUARD_THRESHOLD` | `0.65` |
| `PI_GUARD_TIMEOUT_MS` | `10000` |

The questions, the clause rendering and the refusal derivation are in
`../shared/env-policy.ts`. The threshold is a starting point calibrated with
`benchmarks/policy.ts`, which also measures whether the policy question changes
any of the risk battery's answers when both ride one request.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Activation, the `tool_call` floor, `/guard` |
| `policy-file.ts` | Parser and validator for `environment.json` |
| `policy-source.ts` | Stat-gated policy loading, with the change signal that drops cached verdicts |
| `numbers.ts` | Validated `PI_GUARD_THRESHOLD` / `PI_GUARD_TIMEOUT_MS` with the warning lines for bad values |
| `refusal.ts` | The blocked-call text |
