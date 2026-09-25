/**
 * Pure helpers for the sandboxed bash override. No pi imports — testable.
 *
 * The override never inspects the command. It hands the whole thing to
 * sandbox-exec, which applies a profile the kernel enforces. See README.md.
 */

import { SANDBOX_COMMAND_ENV } from "../shared/sandbox";
import { shellQuote } from "../shared/shell-quote";
import { READONLY_TOOL } from "../shared/shell-tools";

/** Absolute path — the extension only activates where this exists. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface SandboxPaths {
  home: string;
}

/**
 * macOS scratch roots. Fixed rather than taken from `$TMPDIR`: a `TMPDIR`
 * pointing under `$HOME` would otherwise make `$HOME` a write zone. Both are
 * given in their resolved form — seatbelt matches vnode paths, so `/var/folders`
 * and `/tmp` must be spelled `/private/...` or they match nothing.
 */
export const SCRATCH_VAR_FOLDERS = "/private/var/folders";
export const SCRATCH_TMP = "/private/tmp";

/** Escape a literal path so it can be embedded in a seatbelt regex. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `-D NAME=value` arguments for profile.sbpl. */
export function profileParams(paths: SandboxPaths): string[] {
  const home = paths.home;
  return [
    // Every dot-entry directly under $HOME is closed, then reopened only where a
    // tool provably needs it. Credential material is dotfiles, and a list of
    // credential paths cannot stay complete, so the class is what gets closed.
    `HOME_DOTFILES=^${escapeRegex(home)}/\\.[^/]*`,
    // Node realpaths a script entry by lstat-ing each segment, so the
    // segments between $HOME and the reopened subtrees below must resolve.
    `HOME_LOCAL=${home}/.local`,
    `HOME_LOCAL_SHARE=${home}/.local/share`,
    `HOME_LOCAL_STATE=${home}/.local/state`,
    `HOME_CONFIG=${home}/.config`,
    `HOME_CACHE=${home}/.cache`,
    // On PATH: without it, PATH lookup fails for every binary in the directory.
    `HOME_LOCAL_BIN=${home}/.local/bin`,
    `HOME_CONFIG_GIT=${home}/.config/git`,
    `HOME_CONFIG_MISE=${home}/.config/mise`,
    `HOME_LOCAL_SHARE_MISE=${home}/.local/share/mise`,
    `HOME_LOCAL_STATE_MISE=${home}/.local/state/mise`,
    `HOME_CACHE_MISE=${home}/.cache/mise`,
    `HOME_ZSHRC=${home}/.zshrc`,
    `HOME_SHELL_PROFILE=${home}/.shared-shell-profile.sh`,
    // Denied after the reopenings, so these win inside them too.
    `HOME_SSH=${home}/.ssh`,
    `HOME_GPG=${home}/.gnupg`,
    `HOME_AWS=${home}/.aws`,
    `HOME_GH=${home}/.config/gh`,
    `HOME_DOCKER=${home}/.docker`,
    `HOME_OP=${home}/.config/op`,
    `HOME_SOPS=${home}/.config/sops`,
    `HOME_GCLOUD=${home}/.config/gcloud`,
    `HOME_KUBE=${home}/.kube`,
    `HOME_KEYCHAINS=${home}/Library/Keychains`,
    `SCRATCH_VAR_FOLDERS=${SCRATCH_VAR_FOLDERS}`,
    `SCRATCH_TMP=${SCRATCH_TMP}`,
  ];
}

export type SandboxMode = "override" | "extra" | null;

export interface ActivationInput {
  platform: string;
  /** Value of PI_SUBAGENT — set by the subagent extension for spawned children. */
  subagent: string | undefined;
  hasSandboxExec: boolean;
  hasProfile: boolean;
}

/**
 * Which registration this process should make, if any.
 *
 * A spawned subagent replaces `bash`: it declared the extension, so it has no
 * business running anything else. The main session keeps its unrestricted `bash`
 * and gets the confined shell under a second name, because that shell cannot
 * write — making it the default there would break commits, tests and builds.
 */
export function sandboxMode(input: ActivationInput): SandboxMode {
  if (input.platform !== "darwin" || !input.hasSandboxExec || !input.hasProfile) return null;
  return input.subagent === "1" ? "override" : "extra";
}

/**
 * Shell script the load-time probe runs inside the profile. Exit 0 means the
 * boundary held: a write outside scratch was refused, no credential path was
 * readable, and a scratch write succeeded. Any other exit means the profile
 * parsed but no longer confines — an exit 0 from `sandbox-exec /bin/sh -c :` only
 * says it parsed, which is why this exists.
 */
export function boundaryProbeScript(): string {
  return [
    `if touch "$HOME/.pi-sandbox-probe" 2>/dev/null; then rm -f "$HOME/.pi-sandbox-probe"; exit 1; fi`,
    `for p in "$HOME/.ssh" "$HOME/.aws" "$HOME/.gnupg" "$HOME/.docker"; do`,
    `  if [ -e "$p" ] && ls "$p" >/dev/null 2>&1; then exit 1; fi`,
    `done`,
    `f=$(mktemp 2>/dev/null) || exit 1`,
    `rm -f "$f" || exit 1`,
    `exit 0`,
  ].join("\n");
}

/** argv for running `script` under a profile: `sandbox-exec -D… -f… /bin/sh -c…`. */
export function sandboxArgs(profilePath: string, params: string[], script: string): string[] {
  const args: string[] = [];
  for (const param of params) args.push("-D", param);
  args.push("-f", profilePath, "/bin/sh", "-c", script);
  return args;
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

/** Minimal slice of pi's Theme — keeps this module importable without pi. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/**
 * Call line for the confined shell in the main session. The built-in shell
 * renderer titles every call `$ <command>`, which is the same prompt `bash`
 * shows, so the two tools are indistinguishable in the TUI. This names the tool
 * instead. Field order matches the built-in: title, then timeout suffix.
 */
export function formatReadonlyCall(args: unknown, theme: ThemeLike): string {
  const { command: raw, timeout } = (args ?? {}) as { command?: unknown; timeout?: unknown };
  const command = typeof raw === "string" ? raw : raw == null ? "" : null;
  const invalidArg = theme.fg("error", "[invalid arg]");
  const emptyArg = theme.fg("toolOutput", "...");
  const commandDisplay = command === null ? invalidArg : command || emptyArg;
  const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
  return theme.fg("toolTitle", theme.bold(`${READONLY_TOOL} ${commandDisplay}`)) + timeoutSuffix;
}
