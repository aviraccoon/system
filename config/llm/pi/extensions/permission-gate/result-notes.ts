/**
 * The notes a tool call's result carries: text staged before the result exists,
 * joined with what a still-running classification will produce.
 *
 * A dialog-path classification can outlive the tool it classified — the user
 * answers before the decisions model does — so its note is resolved here, under
 * a bound, instead of being appended when the classification happens to land.
 * Both sources can have something to say about the same call (a staged note — tirith's
 * fact for an allowed call, or an advice note — and an in-flight classification), and the
 * same note can arrive from both once the classifier finishes before the result does, so
 * identical notes are not repeated.
 * No pi imports: the resolution is testable without the extension.
 */

/** How long a result waits for a classification that has not finished yet.
 *  The classifier's own cap is 5 s; waiting that long would delay the result the
 *  user is watching. */
export const NOTE_WAIT_MS = 2000;

/** The note for a result: the staged notes, the in-flight one when it lands
 *  within `waitMs`, or both — each text once, in that order. */
export async function resolveResultNote(
  staged: readonly string[] | undefined,
  inFlight: Promise<string | undefined> | undefined,
  waitMs: number = NOTE_WAIT_MS,
): Promise<string | undefined> {
  const late = inFlight ? await Promise.race([inFlight, delay(waitMs)]) : undefined;
  const notes = [...(staged ?? []), ...(late ? [late] : [])].filter((note, i, all) => all.indexOf(note) === i);
  return notes.length > 0 ? notes.join("\n\n") : undefined;
}

/** A promise that resolves to undefined after `ms`, for the wait race. */
function delay(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}
