# notify

Tells you when pi finishes a run, or starts waiting on a dialog. It works in the
interactive UI only: an rpc client renders its dialogs itself, and a terminal
frame written into its stdout would corrupt the JSON-RPC stream; print and json
runs have no UI to write to.

Both triggers are pi events:

- `agent_settled`: the run is over and no retry, compaction, steering or queued
  message will continue it. `agent_end` fires earlier and is not that signal.
- `ui_prompt_start`: any extension opened a blocking dialog, `custom()` included,
  so a dialog added later needs no cooperation here. `ui_prompt_end` closes it.

## Frame and push

**Terminal frame.** Written for every trigger, in the interactive UI, when the
environment identifies a notification protocol (see Terminal support). It carries
the last command, a snippet of the answer, and the dialog's title.

**Push (ntfy).** Only when nobody is at the keyboard. It carries the project, the
duration, the tool count, outcome flags (the last tool failed, the answer was
truncated) and which kind of dialog is waiting: `confirm`, `select`, `input`,
`editor`, or `dialog` for `custom()`. It never carries command text, model output
or a dialog title: titles are authored by other extensions and can quote a diff.

## When a push fires

`away` is measured from macOS keyboard and pointer idle time. Unknown idle counts
as away, because a stray notification costs one glance while a queued dialog
nobody answers costs the run.

- A dialog is waiting: push when away.
- A run finished: push when away, and the run lasted at least
  `PI_NOTIFY_MIN_RUN_SECONDS`.
- A run ended with Escape is a decision, not news: it never notifies.

## Sound

A cue plays when a run finishes, or when a dialog starts waiting, in the
interactive UI, once the user is away. It is generated rather than taken from a
sound file, and played with `afplay`: a terminal notification frame has no sound
field, so the terminal never hears about it.

The melody is a function of the project directory name, the same name the frame
and the push carry: five notes from a major pentatonic, so no project gets a
dissonant interval. A finished run plays the motif as a bell arpeggio that
resolves. A waiting dialog plays the first four notes a fifth up, twice, with a
hard attack and a cut tail: the repetition is the "again" signal, and the cut
tail leaves it unresolved.

Cues are cached in `~/Library/Caches/llm/notify/`, one file per project and
shape. The cache is disposable: a missing cue is regenerated on next use. The
synthesis version is in the filename, and a file from another version is deleted
on the next cue.

A cue waits for the same silence a push does, at a lower threshold, and does not
require a long run: a stray cue costs a sound, a stray push buzzes a phone.

Cues play on macOS only: the player is `afplay`. Elsewhere they stay off.

## Terminal support

- Ghostty, WezTerm, foot, rxvt-unicode: OSC 777.
- iTerm2: OSC 9, with the title folded into the message.
- tmux: the same frame in DCS passthrough, which needs
  `set -g allow-passthrough on`.
- kitty: nothing. Its OSC 99 nests key=value metadata, and a frame the terminal
  misparses is worse than none.
- Terminal.app, Alacritty: nothing, they have no notification protocol.
- ssh session: nothing is detected, because ssh forwards neither `TERM_PROGRAM`
  nor `TMUX`. Set `PI_NOTIFY_PROTOCOL`, or run pi inside tmux on a terminal that
  takes OSC 777.

## Configuration

The cue cache under `~/Library/Caches/llm/notify/` and the optional topic file
are the only files it touches.

- `PI_NOTIFY_OFF=1` turns every channel off.
- `PI_NOTIFY_NTFY_URL` is an ntfy topic or a full URL; a bare topic means ntfy.sh.
- `PI_NOTIFY_NTFY_FILE` is a file holding the topic, read when the variable is
  unset. Default `~/.config/llm/notify-ntfy-url`.
- `PI_NOTIFY_PROTOCOL` forces the frame protocol: `777`/`osc777`, `9`/`osc9`, or
  `off`/`none`. Unset, or anything else, detects from the environment.
- `PI_NOTIFY_IDLE_SECONDS` is the idle time that counts as away. Default 60; `0`
  means always away.
- `PI_NOTIFY_MIN_RUN_SECONDS` is the shortest run worth a push. Default 300; `0`
  sets no minimum, and the away gate still applies.
- `PI_NOTIFY_SOUNDS` set to `0`, `off` or `false` silences the cues. Unset, they
  play.
- `PI_NOTIFY_SOUNDS_IDLE_SECONDS` is the idle time that counts as away for a cue.
  Default 20; `0` plays a cue whenever a run settles or a dialog opens.

The topic is a secret: export `PI_NOTIFY_NTFY_URL` from the environment that
starts pi, or keep it in the file. No URL configured means no push, silently. A
failed push shows one warning toast per session; the topic never appears in the
message.

## Testing

`/notify test` writes a terminal frame, plays both cues in order (finished run,
then waiting dialog) and, when a topic is configured, sends a push. It reports
what each channel reached: a terminal with no protocol, a protocol forced off,
and a cue that could not be written or played.
