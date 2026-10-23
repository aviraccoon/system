/**
 * Shell commands the gate refuses from a tool call.
 *
 * Text matches, not a boundary: a command that reaches the same effect another
 * way is not caught. They sit in one place so the rule the README states is the
 * rule a test can fail.
 */

/** Blocked by the gate's own state: an agent that writes a verdict can clear it. */
const STATE_REASON = "review-gate state is written only by the extension; use /review-gate status to read it.";

/** A repository-local hooks path shadows the gate's hooks entirely. */
const HOOKS_PATH_REASON =
  "core.hooksPath selects the hook directory, so any command naming it is refused: changing or overriding it can bypass the review gate. /review-gate status shows the effective path.";

/** The gate applies to agent sessions only, so clearing the marker skips it. */
const SESSION_REASON = "PI_SESSION_ID is the review gate's agent-session marker; do not clear or reassign it.";

const SESSION_CLEARED = /(\benv\b[^;&\n]*-u\s+PI_SESSION_ID\b|\bunset\s+PI_SESSION_ID\b|PI_SESSION_ID=)/;

export function shellDenialReason(command: string, stateDir: string): string | null {
  if (command.includes(stateDir) || command.includes(".pi/agent/state")) return STATE_REASON;
  // git's config names are case-insensitive: `core.hookspath` selects a directory too.
  if (/core\.hookspath/i.test(command)) return HOOKS_PATH_REASON;
  if (SESSION_CLEARED.test(command)) return SESSION_REASON;
  return null;
}
