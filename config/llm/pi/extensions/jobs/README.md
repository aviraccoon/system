# jobs

`bash` for pi that turns a command still running after a minute into a background job. The job outlives the
turn and pi itself, and its completion arrives as a message rather than as something the model waits on.

## What you need

Nothing beyond this pi configuration: the extension loads with it, and `bash` calls go through it.

## Try it

Ask the agent to run `sleep 120`. The call returns after a minute with a job id, the footer shows
`jobs 1 · sleep 120 1m02s`, and the command's output arrives as a message when it finishes.

```
/jobs                 this project's running jobs
/jobs <id>            one job's command and output
/jobs kill <id>|all   kill without opening the picker
```

## The /jobs screen

A panel flush with the bottom edge, with a rule as its top edge, so the transcript stays readable above it. It sizes
itself from the terminal height: at most 30 lines, and never within three rows of the top. The footer is covered
while it is open. The list covers this project's running jobs, with settled records hidden until asked for. The
panel shows its own keys on its last line or two, and this is the complete list:

| key | action |
| --- | --- |
| `up`, `down`, `pgup`, `pgdn` | move the selection |
| `enter` | open the job's command and output |
| `Ctrl+K` | kill; press it twice, any other key cancels |
| `Ctrl+T` | show or hide finished jobs |
| `Ctrl+A` | cycle the scope: this project, this session, all directories |
| `Ctrl+Y` | copy: the selected job's output in the list, the focused pane in the output screen |
| `Ctrl+O` | open the folder holding the job's files |
| `Ctrl+X` | clear finished records; press it twice |
| `tab` | switch focus between the command and the output |
| `esc` | back, then close |

The output screen shows the command in full, a heredoc's newlines included, with the log below it following the
tail while the job runs. Scrolling up stops the follow and `End` re-attaches it. The mouse wheel scrolls the focused
pane, and `tab` is what moves the focus.

A job whose caller set a `timeout` shows `elapsed/budget` instead of the plain clock, in the warning color from
three quarters spent and the error color from nine tenths.

`Ctrl+O` opens the selected job's own directory, which holds its status, command, output and generated script; with
nothing selected it opens the directory holding all of them.

## Limits and footguns

- A job carries whichever of pi's five session variables the session has (`PI_SESSION_ID`, `PI_SESSION_FILE`,
  `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`); `SESSION_ENV_VARS` in `bash-tool.ts` mirrors pi's list.
- `timeout` is the command's total time budget, not a wait limit: a budget that expires inside the foreground window
  kills the command, and only a call that outlives the window becomes a job. The largest budget a caller can ask for
  is an hour.
- Pressing escape kills the command, as the built-in tool does. If the process cannot be signalled, the call says so
  and the job keeps running. Escape only reaches a call that is still in flight; a promoted job is killed from
  `/jobs`.
- Completion is pushed, so polling is wasted work: `sleep`, `ps`, `pgrep` and log tailing all spend turns
  learning nothing. A completion is steered into the running turn: once the job finishes, it reaches the model
  after the tool calls in flight and before its next step. It carries the log's tail and names the log's path
  whenever lines were left out or the job failed. A failed log that was read whole also brings its start, when the
  tail leaves lines before it, and a single line over 400 characters is shortened in place, keeping its start.
- The footer and `/jobs` cover this directory's jobs. `Ctrl+A` widens `/jobs` to this session or to every
  directory, and work started elsewhere is counted as `+1 elsewhere` rather than named.
- A job records the session that started it, and another session's job is marked `@other`. `/jobs kill all` and
  `Ctrl+X` only touch this session's jobs, so a second pi window in the same project cannot lose a build to your
  cleanup.
- `/jobs` shows the last 2000 lines of a log, with a line saying how many it skipped. `Ctrl+Y` copies up to the
  last 1 MB and says so when it cut.
- Commands run without a pty, so there is no pager and no password prompt.
- Killing a job kills the local process. An `ssh` command takes its remote command with it. A `docker exec`
  does not: the container-side process keeps running after the client it was started from is gone.
- In a subagent this extension leaves `bash` unregistered, so `sandbox-bash` owns the name wherever it confines it.
- The permission gate approves a command once, when it starts. A promoted job's later effects are not
  classified again.
- If pi exits first the job keeps running: the budget dies with pi, the job records its own exit, and a finished record
  stays readable in a later session. Not across a reboot: the job files live under `$TMPDIR`, which the OS clears.
- Finished records are pruned after three days, and `Ctrl+X` deletes them on request. A record whose process is
  gone and that nothing saw die is pruned an hour after its last output, or an hour after it started if it never
  wrote any. A running job is never pruned.
- `PI_JOBS_FOREGROUND_SECONDS` sets the foreground window (default 60). `PI_JOBS_DIR` sets where job files
  live (default `$TMPDIR/pi-jobs`).

## Where to go next

Why completion is pushed instead of polled, and what a job's files carry, are in the comments on `index.ts` and
`runner.ts`. The extension list is in `../../README.md`.
