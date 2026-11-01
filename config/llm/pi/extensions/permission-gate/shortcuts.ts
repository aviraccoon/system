/**
 * The gate's keyboard chords, defined once.
 *
 * The dialog's matchers, the hints that name a chord, and the global shortcuts all read
 * these ids, so a hint cannot advertise a key the handler does not match.
 *
 * The toggles carry Shift so a text field keeps its own keys: Ctrl+A and Ctrl+E are
 * line-start and line-end while a note is written (`tui.editor.*` in pi-tui). Tab cycles
 * focus and Enter confirms, which is why those two are the dialog's even though the editor
 * binds them, and the diff toggle needs no Shift because the editor does not bind Ctrl+O.
 */
import type { KeyId } from "@earendil-works/pi-tui";

export const GATE_SHORTCUTS = {
  /** Toggled globally and from the dialog, so the chord is the same in both places. */
  autoClassify: "ctrl+shift+c",
  /** Global only: the dialog has no mode control. */
  cycleMode: "ctrl+shift+a",
  explanation: "ctrl+shift+e",
  diff: "ctrl+o",
} as const satisfies Record<string, KeyId>;

/** How a chord reads in the UI: `ctrl+shift+c` becomes `Ctrl+Shift+C`. */
export function shortcutLabel(id: KeyId): string {
  return id
    .split("+")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("+");
}
