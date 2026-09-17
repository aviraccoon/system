/**
 * Every tool that runs a shell command.
 *
 * Checks on shell *text* — output filtering, flag misuse — apply to all of
 * these. Checks on filesystem mutation must not, because a confined shell cannot
 * write. A new shell tool that is missing here is silently skipped by the text
 * checks, which is the same failure mode as a missing `EDIT_LIKE_TOOLS` entry.
 */

/** Tool name the confined shell takes, per sandbox-bash mode. */
export const CONFINED_TOOL = "bash"; // subagent: replaces the built-in
export const READONLY_TOOL = "bash_readonly"; // main session: an extra tool

export const SHELL_TOOLS: string[] = [CONFINED_TOOL, READONLY_TOOL];

export function isShellTool(toolName: string): boolean {
  return SHELL_TOOLS.includes(toolName);
}
