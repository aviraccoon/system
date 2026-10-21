---
name: live-verify
description: "Verifies behavior that only a run reveals, or explores a running product for defects: launch it, drive it, capture and report the evidence. Use when a change touches a TUI, web page, mobile screen, desktop app, API, service, VM or generated artifact; when the check is live rather than a test: a simulator, emulator, device, port or service; when asked to smoke test, walk through, manually check, confirm it works, or to audit, explore or sweep the running product for defects (an accessibility pass, finding pain points, clicking through a flow); and before claiming or committing a change that only a run can show. Reading the code is not the check, and a test only covers what it can pin."
---

# Verify by running it

Use this when a test cannot see the behavior, or when the job is to find out what is broken rather than
confirm a known change. A test cannot see key handling, focus, layout, a request actually reaching a
provider, an installed artifact, or a device. If the behavior can be pinned in a test, write the test
instead. A defect hunt runs as a charter, not a journey (see Two modes below).

## When to propose it

Say it in one sentence: "this needs a run: the footer pill only exists in the TUI". A short check does not
need permission; a long journey against a real environment does.

In an autonomous run (`/auto`), do it as part of the unit instead of proposing it: run the check,
capture the delta, and record the result with the unit. A surface that will not come up is reported with
its reason, not silently dropped.

## The loop

1. **State the claim.** One sentence: what should be observable, and where. "After saving, the footer
   shows the new state and the next request carries it." A claim you cannot write down cannot be
   verified.
2. **Fix the artifact under test.** Record the commit (or build id) and the launch path. Verify the build
   from the working tree; name anything that needs deploying first (a rebuild, an install, a migration)
   before claiming a result. A process that is already running keeps the code it loaded, so restart or
   reload it before verifying an edit to that process.
3. **Check prerequisites.** Surface, device, port, credential, seeded data. Missing: report
   `skipped: <reason>`. Skipped is not passed.
4. **Launch isolated.** Own tmux socket, own port, own simulator, own temp data. Never kill something you
   did not start; reuse is governed by the isolation rules above.
5. **Predict, then act.** Write the expected observable change before the keypress. Then act and poll
   for state; never sleep a fixed time.
6. **Read the evidence.** A capture nobody read is not a verification. Assert the property (the row is
   marked, the counter moved, the value survives a reload), not "it looks fine".
7. **Capture before teardown.** On a failure, save the screen, the log and the request before killing
   anything. A torn-down session cannot be debugged.
8. **Record and clean up.** Captures go under the run's `mktemp -d` directory. Kill the session,
   confirm the port and device are free.

## Isolation

A live check touches process state: a port, a simulator, a logged-in session, a database. A private
instance removes the conflict instead of managing it, so prefer one whenever the project can boot it.

1. **Prefer a separate instance.** Own port, own data directory or database, own browser profile or
   simulator. Most projects can: a `--port` flag, a data-dir env var, a compose file, a scratch schema.
2. **If it cannot, share the dev instance knowingly.** Never production, never a server someone else is
   using, never real data. One driver at a time, and the evidence line names the instance that was
   driven.
3. **Record the spin-up once**, in `~/notes/llm/<project>/.agents/verify/instance.md`: launch command,
   ports, data dir, reset, teardown, and what to do when a step is unavailable. Read it before
   launching; update it after a run that needed a new step.
4. **Temp data stays in the run's temp directory.** A `mktemp -d` directory per run, captures inside,
   cleaned by the OS and not worth keeping. The journal entry carries the claim, the delta and the
   finding; the path only has to survive the session, so copy anything worth keeping into the journal as
   text.
5. **Never kill what you did not start.** Confirm teardown: instance gone, port free, the instance's data
   directory removed. A leftover instance is how the next run gets a false result.
6. **Sentinel data and a trap.** `-10`, `999999`, `1970-01-01` for rows or records the check inserts,
   cleanup in a trap, so a re-run is not double-counted and a crash does not leave data behind.

## Two modes

**Journey** - a named, repeatable walk: launch, steps, assertions, evidence. Re-run after later
changes. A journey must fail when the behavior regresses *and* when its expectation goes stale;
otherwise it becomes ritual.

**Charter** - time-boxed exploration: a target ("create, edit, delete a task as a first-time user"), a
risk appetite, and heuristics (empty input, long text, double click, back button, interrupted network,
wrong role, smallest viewport). Report findings, not pass/fail. Set the time box and the stop rule
before starting, or it never ends.

## Rules

1. **An action is not a result.** Every state-changing action needs a postcondition checked
   independently of that action: after save, reload and read the value; after send, look at the outbound
   request; after a keypress, diff the screen.
2. **Semantic evidence first, pixels second.** Roles, names, text, values, request bodies and status
   codes. A screenshot answers "is it laid out correctly", not "did the operation land". Keep image
   diffs only where a human reviews the diff.
3. **Assert a property, not a golden capture.** "The selected row moved" or "the counter incremented"
   survives UI churn; a full-pane golden goes stale silently. Keep the full capture as evidence, not as
   the assertion.
4. **Poll for state; match failure states too.** Wait for the outcome marker, and include error markers
   in the pattern, or a real failure turns into a timeout.
5. **Name what was not verified.** A partial run reports its gaps. An unverified positive is worse than
   a stated gap.
6. **Do not fix while verifying.** A defect found on the walk gets recorded and the walk stops. Mixing a
   fix into the run leaves neither the fix nor the verification reviewed.
7. **Captures may hold personal data.** Screens of notes, mail or messages stay in the run's temp
   directory, never in the repo, and never in a commit.
8. **Report evidence, not success.** What was run, what was seen, where the capture is. "Verified"
   without a path is a claim.

## Surfaces

Read [references/surfaces.md](references/surfaces.md) for the per-surface commands: terminal UI and CLI
(tmux), web, mobile, desktop, API, service, VM, generated artifact. Each tool ships its own skill or help
output, and that is the authority; read it in full before driving the surface.

Terminal surfaces are the cheapest and the least obvious. Launch the app in a detached tmux session with a
fixed geometry, capture the pane, send one key, capture again, and `diff` the two: the delta is the
assertion. An empty diff after a keypress means an inert component, a swallowed key, or a pane that never
rendered - a failure, not a pass. [references/surfaces.md](references/surfaces.md) has the tmux recipe
and the `wait_for` poll.

## Reporting

Three lines in the reply, plus the evidence path:

```
claim:     <one sentence>
artifact:  <commit or build id, launch path, instance and port>
seen:      <the observable delta, quoted from the capture>
evidence:  <run temp dir>/<capture file>
```

A charter reports one entry per finding: the finding in place of the claim, with its own seen and
evidence lines.

On a failure, name the bucket before proposing a cause: app, scenario, or environment. Read
[references/triage.md](references/triage.md) rather than guessing; the same three buckets cover nearly
every false alarm.

## Where journeys live

A journey is project knowledge, not skill knowledge. Journeys and the spin-up recipe live together in the
notes tree, which is also the only place they can live for a repo that belongs to a team:

```
~/notes/llm/<project>/.agents/verify/
  instance.md        # how to launch an isolated instance: ports, data dir, reset, teardown
  <journey>.md       # one walk
```

A journey file:

```markdown
# <journey name>
Prereqs: <surface, port/device, credential, seed>
Steps:   1. ...  2. ...  3. ...
Expect:  <the observable change per step>
Evidence: <what to capture>
```

Write a journey the first time a walk is worth repeating, and add any step a run had to discover. A repo
that other people also verify can keep a copy under `docs/verify/`; the notes copy is the one to update.

After a journey has passed by hand twice, consider turning it into an automated test. That conversion is
the point: this skill covers the period before the test exists, and anything that regresses twice belongs
in the suite.

## When not to use

- Logic a unit or integration test can pin. Write the test.
- As a substitute for the failing test that should have caught the bug.
- On every change. Docs, config and type-only changes have nothing to run.
- Because a change is large. Run it because the change is unobservable by tests.
