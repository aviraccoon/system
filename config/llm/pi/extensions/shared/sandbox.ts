/**
 * Names and decisions shared between the sandboxed-bash extension and the
 * permission gate. Both run in the same process, and the environment is the only
 * channel between extensions: pi loads each one through its own jiti instance with
 * `moduleCache: false`, so a module imported by both is two separate instances.
 *
 * The value is the *name* of the confined tool, not a boolean. The main session
 * registers a second confined tool and leaves the unrestricted `bash` in place, so
 * "a confined shell exists" does not say which calls are safe to auto-allow.
 * Comparing the value against the tool name means a wrong or stale value cannot
 * grant more than the name it holds.
 */

/** Set by the sandbox-bash extension to the name of the tool it confined. */
export const BASH_SANDBOX_ENV = "PI_BASH_SANDBOX";

/** Carries the agent's command to the sandboxed shell. */
export const SANDBOX_COMMAND_ENV = "PI_SANDBOX_COMMAND";

/** Whether this call is the one the sandbox extension confined. */
export function isConfinedBash(toolName: string): boolean {
  return toolName !== "" && process.env[BASH_SANDBOX_ENV] === toolName;
}
