/**
 * The output-capture advisory: one typed question the permission gate asks
 * alongside the risk battery on bash calls, and the policy that turns the
 * answer into a block.
 *
 * The property is workflow waste, not danger: a long diagnostic operation whose
 * output reaches the reader only through an inline filter or /dev/null forces a
 * full re-run the moment the filtered view proves insufficient — reading a
 * captured file back is cheap, re-running the suite is not. The block threshold
 * is set from the measured noul gap (allows near 0, blocks above 0.6) rather
 * than the battery's doubt-preferred tuning.
 */

import type { DecisionsQuestion } from "./decisions";

export const ADVICE_QUESTION: DecisionsQuestion = {
  type: "noul",
  instructions:
    "Does this call run a long diagnostic operation — a test suite, build, typecheck or lint gate, benchmark, codegen, or a project-defined check task — and show that operation's own output only through an inline filter (a pipe into head, tail, grep, awk or sed) or by discarding it to /dev/null, instead of capturing it into a file? Reading a captured file back is cheap; re-running the operation is expensive. Silencing known-noise segments (like a formatter) is fine; the diagnostic operation itself must land in a file — an exit-code echo does not replace its output.",
  criteria: {
    true: "It runs such a long diagnostic operation — including through a task runner whose task name is the only hint — and that operation's own output reaches the reader only through a filter pipe or /dev/null (an exit-code echo does not count as output), with no redirect of that operation's output to a file anywhere in the command.",
    false:
      "The operation's output is redirected to a file — reading slices of that file back with tail or grep is the correct shape — or the filtered or discarded output belongs to a genuinely short, small-output operation (listing files, version and status checks) where the filter is the point, or only noise segments (formatters) are silenced while the diagnostic operation is captured to a file or runs visibly.",
  },
};

/** At or above this noul the gate blocks with a capture rewrite. Measured on
 *  the advisory bench (BENCH_SEED adv-1..3, 3×24 cases): block-side nouls sit
 *  0.69–0.94, allow-side 0.02–0.11, so 0.6 keeps a 0.49 margin above the
 *  highest allow while catching every block shape; 0.9 misses the compound and
 *  silenced-diagnostic shapes entirely. */
export const ADVICE_BLOCK_THRESHOLD = 0.6;

export function adviceBlocks(noul: number): boolean {
  return noul >= ADVICE_BLOCK_THRESHOLD;
}

/** Append the advice noul to a classification result's detail, so the session
 *  log (and the dialog, at the noise floor) carries the score for tuning. The
 *  result type is structural: shared code cannot import permission-gate. */
export function withAdvice<T extends { detail: string }>(result: T, noul: number): T {
  return { ...result, detail: `${result.detail}\nadvice ${noul.toFixed(2)}` };
}

/**
 * The gate's advisory interception: a block reason only when the call would
 * otherwise proceed silently (an auto-allow) and the advice noul crosses the
 * threshold. A call that opens a dialog anyway needs no advisory block — the
 * dialog already shows the command and the advice line.
 */
export function adviceInterception(
  advice: number | undefined,
  action: "allow" | "confirm" | "block",
): { block: true; reason: string } | null {
  if (action !== "allow" || advice === undefined || !adviceBlocks(advice)) return null;
  return { block: true, reason: adviceBlockReason() };
}

/** The block reason: what was detected and the capture instruction. The agent
 *  picks the output file name. */
export function adviceBlockReason(): string {
  return (
    "output-capture: this looks like a long diagnostic whose output is filtered or discarded instead " +
    "of captured — the moment the filtered view proves insufficient, the whole operation has to re-run. " +
    "Capture it instead: redirect the diagnostic's output to a file under /tmp (… > /tmp/<name>.log 2>&1) " +
    "and read or filter the file afterwards; re-reading is cheap, re-running is not."
  );
}
