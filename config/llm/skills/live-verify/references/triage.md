# Triage

A live check fails for one of three reasons. Name the bucket before proposing a cause; the wrong bucket sends the fix into the wrong file.

## The three questions

1. **Is this the artifact under test?** Commit, build path, install step. A stale install, a cached
   bundle, a container still on the old image, or a plugin that needs reinstalling before it appears all
   produce a failure that no code change explains.
2. **Is the state fresh?** New session, new data, cleared cache, empty temp dir. Leftover rows, leftover cookies, a leftover instance still holding the port or receiving keys silently.
3. **Does it reproduce from a clean session?** Same steps, fresh state. If it does not, the scenario is the problem.

## Buckets

**Environment** — the thing under test never got a fair run.

- Connection refused, permission dialog waiting, simulator not booted, port in use, no credential, wrong env var, clock or locale mismatch.
- Data that expired: a cache past its TTL, a token, a feed. The app is right; the input was yesterday's. Report the age of the data you consumed.
- A sandbox, a permission prompt or a read-only shell refusing access. That is a refusal, not a product failure; find out which layer refused before retrying.
- Signature: the failure moves when the environment changes, or it reproduces outside the app entirely.

**Scenario** — the walk is wrong, the product is not.

- The assertion ran before the state marker appeared, or slept instead of polling.
- A stale ref (`@e`/`@N` from an older snapshot) points at a different element now.
- Viewport or terminal size clipped the text being asserted; scrollback holds it but the visible pane does not.
- Fixture data left from the previous run, or a fixture that never matched real data.
- The expectation described the old behavior and nobody updated it. Stale expectation is a scenario failure by definition.
- Signature: it passes when you do the same thing by hand, or it passes from a fresh state with the same steps.

**App** — the product is wrong.

- Reproduces from a clean session with the same steps, and the screen or response contradicts the claim.
- Signature: consistent across runs and across environments, or the delta is exactly at the boundary the change touched.

If the failure is intermittent, it is not "flaky": either the scenario has a timing assumption or the app has a race. Find which; a retry loop hides both.

## False greens

Worse than a failure, because it ends the check.

- **The action's own success taken as the postcondition.** A click returning without error proves a click. A toast proves a toast. Read the state that follows, or re-read it after a reload.
- **An echo test.** A check whose expected answer was supplied by the check itself passes whether the artifact loaded or the prompt was answered as plain text; ask for a value only the loaded artifact can supply.
- **A capture nobody read.** Producing `shot.png` is not evidence; the assertion is.
- **A screenshot from before the change.** Fresh capture, named by time, in a directory keyed by the run.
- **An optimistic UI.** The row appears instantly and the request fails silently. Check the request, not the list.
- **A mock standing in for the service.** If the real dependency was never reached, say so; the check covers the wiring at most.
- **Asserting a proxy.** A count, an ordering, or a disabled button can hold under both the old and new behavior. Assert the state the change flips.

## Before reporting an app bug

- Re-run once from a clean session with the same steps, and keep both captures.
- State which artifact was under test, including build path and commit.
- Say what was not exercised. A partial run reports gaps; it does not round up to "looks fine".
- Record the defect and stop the walk. A fix made mid-verification leaves neither the fix nor the run reviewed.
