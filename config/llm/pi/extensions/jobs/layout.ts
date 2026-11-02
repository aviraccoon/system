/**
 * How tall a jobs dialog may be and how it divides those rows.
 *
 * The cap is the whole point: the dialog is an overlay composited onto the frame's last rows, so a
 * render taller than the screen loses its bottom, the hint line first. The arithmetic assumes at
 * least nine rows: below that the rows a view cannot drop (rule, title, blank, one body row, two
 * hints) exceed the budget. Everything here is arithmetic on purpose, so it is testable without a
 * terminal.
 */

/** Rows kept for the transcript above the panel, so a dialog never becomes the whole screen. */
const DIALOG_RESERVED_ROWS = 8;
const DIALOG_MIN_ROWS = 6;
const DIALOG_MAX_ROWS = 30;

/**
 * The panel's top edge: one row of rule. The panel is full width and flush with the bottom, so the
 * other three edges are the terminal's, and this is what keeps it from reading as spilled transcript.
 */
export const DIALOG_RULE_ROWS = 1;

/** The rows a dialog may occupy: about two thirds of the screen, bounded at both ends. */
export function dialogHeight(rows: number): number {
  // The hard cap: three rows of transcript stay above the panel, which is anchored to the bottom edge.
  const hardMax = Math.max(1, rows - 3);
  const wanted = Math.max(DIALOG_MIN_ROWS, Math.min(DIALOG_MAX_ROWS, rows - DIALOG_RESERVED_ROWS));
  return Math.max(1, Math.min(wanted, hardMax));
}

/**
 * A panel's content rows: the dialog budget minus the rule that marks its top edge. At four rows or fewer
 * the rule still costs its row, so the framed render is one over `dialogHeight`.
 */
export function panelHeight(rows: number): number {
  return Math.max(1, dialogHeight(rows) - DIALOG_RULE_ROWS);
}

/** The list's rows: everything but the title, the blank under it and the two hint lines. */
export function listBodyHeight(height: number): number {
  return Math.max(1, height - 4);
}

export interface Window {
  start: number;
  end: number;
}

/**
 * The slice of `total` rows to draw so `selected` stays visible. Centering the selection keeps
 * context on both sides, and clamping the start keeps the window full at either end.
 */
export function windowRows(total: number, selected: number, height: number): Window {
  const size = Math.max(1, height);
  if (total <= size) return { start: 0, end: total };
  const chosen = Math.max(0, Math.min(total - 1, selected));
  const start = Math.max(0, Math.min(total - size, chosen - Math.floor(size / 2)));
  return { start, end: start + size };
}

/**
 * The output view splits its body between the command pane and the log. The command gets what it
 * needs up to 40% of the body, so a one-line command costs one row and a heredoc cannot starve the
 * output; the log keeps the rest.
 */
export function splitOutput(height: number, commandLines: number): { command: number; log: number } {
  // Chrome: the header, the blank between the panes, and the hint.
  const body = Math.max(2, height - 3);
  const cap = Math.max(1, Math.floor(body * 0.4));
  const command = Math.max(1, Math.min(commandLines, cap));
  return { command, log: Math.max(1, body - command) };
}
