/**
 * Names shared between the sandboxed-bash override and the permission gate.
 * Both run in the same process; the environment is the channel because the
 * override may also be loaded where the gate is not.
 */

/** Set by the sandbox-bash extension when `bash` is confined by the OS. */
export const BASH_SANDBOX_ENV = "PI_BASH_SANDBOX";

/** Carries the agent's command to the sandboxed shell. */
export const SANDBOX_COMMAND_ENV = "PI_SANDBOX_COMMAND";

/** Whether this process runs a bash that the OS already confines. */
export function bashSandboxed(): boolean {
  return Boolean(process.env[BASH_SANDBOX_ENV]);
}
