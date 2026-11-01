/**
 * The jobs dialog's chords, defined once so a hint cannot advertise a key the handler ignores.
 *
 * Plain ctrl, no Shift: this dialog has no text field, so the editor's chords are not in use, and
 * pi's app chords hang off the default editor, which a dialog replaces. What stays pi's is
 * navigation: `tui.select.*` maps escape and ctrl+c to cancel, and the fullscreen renderer owns the
 * page keys and ctrl+home/end before a component sees them.
 */
import type { KeyId } from "@earendil-works/pi-tui";

export const JOB_SHORTCUTS = {
  /** Two presses: the second one kills, any other key cancels. */
  kill: "ctrl+k",
  /** Show or hide settled records, which the default view filters out. */
  finished: "ctrl+t",
  /** Cycle the list between this project, this session, and every directory. */
  scope: "ctrl+a",
  /** Copy the focused pane: the command or the output. */
  copy: "ctrl+y",
  /** Show the shared jobs directory, which holds every job's log, script, command and status. */
  openFolder: "ctrl+o",
  /** Two presses: delete the finished records this session started. */
  clearFinished: "ctrl+x",
} as const satisfies Record<string, KeyId>;
