/**
 * Pure helpers for the sandboxed bash override. No pi imports — testable.
 *
 * The override never inspects the command. It hands the whole thing to
 * sandbox-exec, which applies a profile the kernel enforces. See README.md.
 */

import { SANDBOX_COMMAND_ENV } from "../shared/sandbox";

/** Absolute path — the extension only activates where this exists. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface SandboxPaths {
  home: string;
  /** Real path of the temp dir — seatbelt matches resolved vnode paths, so
   *  /var/folders must be given as /private/var/folders or it matches nothing. */
  tmpdir: string;
  /** Real path of the shared temp dir (/tmp → /private/tmp). */
  tmp: string;
}

/** `-D NAME=value` arguments for profile.sbpl. */
export function profileParams(paths: SandboxPaths): string[] {
  const home = paths.home;
  return [
    `HOME_SSH=${home}/.ssh`,
    `HOME_GPG=${home}/.gnupg`,
    `HOME_AWS=${home}/.aws`,
    `HOME_GH=${home}/.config/gh`,
    `HOME_DOCKER=${home}/.docker`,
    `HOME_OP=${home}/.config/op`,
    `HOME_KEYCHAINS=${home}/Library/Keychains`,
    `HOME_NETRC=${home}/.netrc`,
    `TMPDIR=${paths.tmpdir}`,
    `TMP=${paths.tmp}`,
  ];
}

export interface ActivationInput {
  platform: string;
  /** Value of PI_SUBAGENT — set by the subagent extension for spawned children. */
  subagent: string | undefined;
  hasSandboxExec: boolean;
  hasProfile: boolean;
}

/**
 * Whether to take over `bash` for this process.
 *
 * Delegated agents only. Pi auto-discovers every extension in the extensions
 * directory, so this file is loaded in the main session too — activating there
 * would make the user's own shell read-only. Per-agent opt-in is the
 * `extensions:` frontmatter, which decides what a spawned child loads; the
 * `PI_SUBAGENT` marker is what distinguishes a child from the main session.
 */
export function shouldActivate(input: ActivationInput): boolean {
  return input.platform === "darwin" && input.subagent === "1" && input.hasSandboxExec && input.hasProfile;
}

/** Single-quote for the shell string the wrapper is built in. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The command the spawn hook substitutes in: sandbox-exec with the profile, and
 * an inner shell that reads the agent's command out of the environment.
 */
export function sandboxCommand(profilePath: string, params: string[]): string {
  const parts = [SANDBOX_EXEC];
  for (const param of params) parts.push("-D", shellQuote(param));
  parts.push("-f", shellQuote(profilePath), "/bin/sh", "-c", `"$${SANDBOX_COMMAND_ENV}"`);
  return parts.join(" ");
}
