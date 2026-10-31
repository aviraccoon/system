# jobs

`bash` for pi that turns a command still running after a minute into a background job. The job outlives the
turn and pi itself, and its completion arrives as a message rather than as something the model waits on.

## What you need

Nothing beyond this pi configuration: the extension loads with it, and `bash` calls go through it.

## Try it

Ask the agent to run `sleep 120`. The call returns after a minute with a job id, the footer shows
`jobs 1 · sleep 120 1m02s`, and the command's output arrives as a message when it finishes.

```
/jobs                 this project's jobs
/jobs kill <id>|all   kill without opening the picker
```

## Limits and footguns

- `timeout` is the command's total time budget, not a wait limit: a budget that expires inside the foreground window
  kills the command, and only a call that outlives the window becomes a job.
- Pressing escape kills the command, as the built-in tool does. If the process cannot be signalled, the call says so
  and the job keeps running. Escape only reaches a call that is still in flight; a promoted job is killed from
  `/jobs`.
- Completion is pushed, so polling is wasted work: `sleep`, `ps`, `pgrep` and log tailing all spend turns
  learning nothing.
- The footer and `/jobs` cover this directory's jobs. `a` in `/jobs` switches to every directory, and work
  started elsewhere is counted as `+1 elsewhere` rather than named.
- Commands run without a pty, so there is no pager and no password prompt.
- Killing a job kills the local process. An `ssh` command takes its remote command with it. A `docker exec`
  does not: the container-side process keeps running after the client it was started from is gone.
- In a subagent this extension leaves `bash` unregistered, so `sandbox-bash` owns the name wherever it confines it.
- The permission gate approves a command once, when it starts. A promoted job's later effects are not
  classified again.
- If pi exits first the job keeps running: the budget dies with pi, the job records its own exit, and a finished record
  stays readable in a later session.
- Finished records are pruned after three days. A record whose process is gone and that nothing saw die is pruned an
  hour after its last output, or an hour after it started if it never wrote any. A running job is never pruned.
- `PI_JOBS_FOREGROUND_SECONDS` sets the foreground window (default 60). `PI_JOBS_DIR` sets where job files
  live (default `$TMPDIR/pi-jobs`).

## Where to go next

Why completion is pushed instead of polled, and what a job's files carry, are in the comments on `index.ts` and
`runner.ts`. The extension list is in `../../README.md`.
