/**
 * Block messages for edit-guard's gates — pure builders, so the emitted
 * commands (shell-quoted paths) and wording are testable without a pi harness.
 */

import { shellQuote } from "../shared/shell-quote";
import { proseGateReason } from "./prose-gate";

/** Prose-gate block: read the skill, then re-issue; a blocked write's content
 * is stashed so cp can re-apply it without re-emitting. */
export function proseGateBlock(displayPath: string, gatedAbs: string, stashPath?: string): string {
  let note = "";
  if (stashPath !== undefined) {
    note =
      ` The blocked content is saved at ${stashPath} (NOT applied) — re-issue the write with any ` +
      `corrections the guide calls for; cp ${shellQuote(stashPath)} ${shellQuote(gatedAbs)} only if it is fine as-is.`;
  }
  return proseGateReason(displayPath) + note;
}

/** Write-to-existing block: patch for targeted changes; a re-issue marks the
 * full rewrite as intended, and the blocked content is stashed for cp. */
export function rewriteBlock(displayPath: string, lines: number, abs: string, stashPath?: string): string {
  let note = "";
  if (stashPath !== undefined) {
    note =
      ` The blocked content is saved at ${stashPath} (NOT applied). Either cp ${shellQuote(stashPath)} ` +
      `${shellQuote(abs)} (preferred — cheaper than re-emitting long content), or simply re-issue the write ` +
      "(any content) — the path is now allowed for the rest of the session.";
  }
  return (
    `edit-guard: ${displayPath} already exists (${lines} lines). Don't use write to replace existing files — ` +
    "use patch for targeted changes (write is for genuinely new files only). " +
    "If a full rewrite is genuinely intended, re-issue the write (any content) — the path is then allowed for the rest of the session." +
    note
  );
}
