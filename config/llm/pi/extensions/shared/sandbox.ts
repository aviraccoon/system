/**
 * Names shared between the sandboxed-bash override and the permission gate.
 * Both run in the same process, and the environment is the only channel between
 * extensions: pi loads each one through its own jiti instance with
 * `moduleCache: false`, so a module imported by both is two separate instances.
 *
 * The gate auto-allows `bash` on the strength of this value, so whoever sets it
 * must set or clear it deterministically — a stale value silently skips
 * confirmation for an unconfined shell.
 */

/** Set by the sandbox-bash extension when `bash` is confined by the OS. */
export const BASH_SANDBOX_ENV = "PI_BASH_SANDBOX";

/** Carries the agent's command to the sandboxed shell. */
export const SANDBOX_COMMAND_ENV = "PI_SANDBOX_COMMAND";

/** Whether this process runs a bash that the OS already confines. */
export function bashSandboxed(): boolean {
  return Boolean(process.env[BASH_SANDBOX_ENV]);
}
