# Surfaces

One section per surface: the commands the loop needs and that surface's gotchas. What follows is the
minimum this loop needs; the authority is the tool's own documentation, which is version-matched and
knows more than this file does. Mobile and desktop are covered by a skill: read the one that fits in full
before the first run. Everywhere else read the CLI help or the project's docs, and reread when a flag
behaves unexpectedly.

If the project already has an automated suite for the surface, run that first: it is cheaper, and it
outlives the session. What follows covers the rest. The commands assume bash; on Windows run them inside
the VM or under WSL.

| Surface | Read in full before driving it |
|---|---|
| Terminal UI and CLI | `man tmux`, `tmux list-commands` |
| Web | `agent-browser skills get core` (and `dogfood` for charter mode) |
| Mobile | its skill |
| Desktop | its skill |
| API | the project's request collection or API docs, `curl --help` |
| Service | the project's run docs, `podman --help` |
| VM | the project's VM docs and its own run tasks |

## Terminal UI and CLI (tmux)

A TUI is a PTY problem, not a stdin/stdout problem. Piping input or redirecting output does not
reproduce key events, focus, raw mode or in-place rendering. A plain CLI whose output can be asserted is
a test, not a journey; this section is for a screen that exists only in a terminal. Without tmux, a PTY
harness in the project's language beats scraping stdout.

```bash
S="verify-$$"                             # unique socket per run
D="$(mktemp -d)"                          # evidence for this run
tmux -L "$S" new-session -d -s app -x 120 -y 40 "<command>"
tmux -L "$S" capture-pane -p -t app > "$D/visible.txt"
tmux -L "$S" capture-pane -p -S -200 -t app > "$D/scrollback.txt"
tmux -L "$S" send-keys -t app -l '/help'   # -l = literal text
tmux -L "$S" send-keys -t app Enter
tmux -L "$S" capture-pane -p -t app > "$D/after.txt"
diff "$D/visible.txt" "$D/after.txt"        # the delta is the assertion
tmux -L "$S" kill-server                    # also removes the socket
```

Wait for state instead of sleeping:

```bash
wait_for() {  # wait_for <regex> [timeout_s]
  local deadline=$((SECONDS + ${2:-30}))
  until tmux -L "$S" capture-pane -p -t app | grep -qE "$1"; do
    (( SECONDS < deadline )) || { echo "timeout: $1" >&2; return 1; }
    sleep 0.3
  done
}
wait_for 'ready|error|failed' 60     # match failure states too
```

Assert the delta: capture, send one key, capture, `diff`. Empty diff means the key did nothing (inert
component, swallowed by a focused input, or the pane never rendered).

Gotchas:

- Fixed geometry makes captures comparable. 80x24, 120x40 and 200x50 are the three worth testing; below 80
  columns layout truncation is the finding, not a bug in the harness.
- A screen with an input is hostile to single-key bindings: drive forms with `Tab`, and check the input for
  stray characters before blaming the app.
- Stale sessions receive keys silently. Kill by socket, not by name.

Any tool that keeps its session in environment variables will inherit the parent's session when launched
as a child. Clear them for an isolated instance; the project's `instance.md` records which ones.

## Web

`agent-browser` is the driver; it ships its own version-matched skills, and those win over anything here.
Read `core` in full before the first request.

```bash
D="$(mktemp -d)"
agent-browser skills get core       # read this first
agent-browser skills get dogfood    # charter-mode exploration of a web app
agent-browser --session "verify-$$" open http://localhost:3000
agent-browser --session "verify-$$" snapshot            # accessibility tree with refs
agent-browser --session "verify-$$" click @e12
agent-browser --session "verify-$$" fill @e14 "text"
agent-browser --session "verify-$$" wait --text "Saved"
agent-browser --session "verify-$$" console
agent-browser --session "verify-$$" errors
agent-browser --session "verify-$$" network requests
agent-browser --session "verify-$$" screenshot "$D/x.png"
```

Assert semantically (`find role button click --name "Save"`, `get value`, `is visible`) rather than by
coordinates. For persistence, round trip it: submit, wait for the completion signal, `reload`, then read
the value from the newly rendered page.

The role+name query covers exposure as a control: a node exposed only as generic cannot be reached as a
control, while a role with no name still matches its role query. It says nothing about focusability —
check that focus reaches the control before calling it reachable. Contrast, and whether landmarks and
table structure are right, sit outside that query; audit those with `agent-browser a11y`. Whether a name
fits its control is a judgement no rule makes — read it from the snapshot.

Gotchas:

- A toast or a disabled button proves the UI reacted, not that the operation landed. Check the request
  and the re-read state.
- `screenshot` answers layout and clipping, not correctness.
- Cookies and logins live per session, so a fresh session may need a setup step.
- The accessible-name filter is a flag (`--name`); a trailing positional is the action's text argument,
  so `find role button click "Save"` drops it and clicks the first button of that role instead of
  failing.
- A snapshot taken straight after navigation, a viewport change or a hot reload can come back partial;
  take it again before reading an empty page as empty.
- Offline emulation and a stopped server both leave service-worker and HTTP-cache responses available,
  so a call that succeeds proves nothing. An uncached call must fail, or the server's own log decides;
  a listed request does not prove the network answered.
- Give captures absolute paths; a relative one lands in the browser daemon's directory, not the shell's.

## Mobile

The surface's skill (`bun <skill dir>/scripts/mobile.ts`) covers iOS simulators, Android emulators and
physical iPhones. Read it in full first: device selection, permissions and the session lifecycle are all
there.

```bash
D="$(mktemp -d)"
M=<skill dir>/scripts/mobile.ts
bun $M devices
bun $M ui                 # outline with @N refs
bun $M tap @7
bun $M ui                 # refs are valid only for the last capture
bun $M shot --out "$D/x.png"
bun $M logs --grep ERROR
```

Build and install with the project's build task, not the individual commands it wraps; without one, run
the commands directly. This driver never builds. Gotchas: a sheet and the screen behind it both appear in
the outline, so the same area can hold two elements (the focused field is marked). Physical iPhones are
screenshot-only. Native permissions dialogs belong to the environment bucket, not the app bucket.

## Desktop

The surface's skill covers the platform matrix and permissions; read it in full before the first action.
Core loop: observe, act, observe again.

```bash
forepaw snapshot --app "App" -i          # interactive elements with @e refs
forepaw screenshot --app "App" --ref @e5 # crop to the element as evidence
forepaw click @e3 --app "App"
forepaw type @e2 "text" --app "App"
forepaw press Escape --app "App"
forepaw snapshot --app "App" -i --diff   # what changed since the last snapshot
```

Coordinates are window-relative and portable. Never act from an old snapshot: the UI may have moved, and
a stale `@e` ref points at whatever now occupies that position.

## API

`curl`, `httpie`, or a project request collection (a Bruno collection, a `.http` file, a script). Assert
the status code **and** the body field that carries the business outcome. Verify idempotency where the
endpoint claims it, and clean up with sentinel ids (`-10`, `999999`) so a re-run is not double-counted.
Never point a live check at production data; name the environment in the evidence line.

## Service

On a remote host: `podman ps` or `docker ps`, the container's logs (`podman logs --tail 100 <name>`,
`journalctl -u <unit>`, `kubectl logs`), and `curl -sS -o /dev/null -w '%{http_code}' <url>`. Then read
the logs for the request you just made: a 200 through a reverse proxy does not prove the container handled
it, the log line does.

## VM

Cross-platform binaries get their own surface. The project usually already has the flow: cross-compile,
copy the test binary to the VM, run it over SSH or a guest agent. Capture the remote output and the remote
exit code; a local unit run does not exercise a conditionally compiled branch (Rust `cfg`, a build tag, an
`#ifdef`), and a green host run beside a red VM run means the VM is right.

## Artifact

Anything generated: a report, a PDF, an export, a rendered page, a dataset. Run the generator, then assert
properties of the output instead of eyeballing it - page count, field values, dimensions, row totals, an
expected section present and an unwanted one absent - and quote what you measured. Keep the artifact as
evidence. A fixture input plus a stored output is the regression form of the same check.

## Choosing

| Signal | Surface |
|---|---|
| A key, a menu, a rendered layout in a terminal | tmux |
| A page, a route, a form, a session | web |
| A gesture, a sheet, a device screen | mobile |
| A native window, a dialog, an OS permission | desktop |
| A status code, a payload, a contract | API |
| A generated file - a report, a PDF, an export | run the generator, inspect the artifact |
| A container, a deploy, a restart | service |
| A compiled binary on another OS | VM |
