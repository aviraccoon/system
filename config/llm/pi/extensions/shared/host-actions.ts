/**
 * Two things a person expects from a desktop app and pi does not offer: put text on the clipboard,
 * and show a directory in the platform's file manager.
 *
 * Both are one command per platform, so the table is the code. The spawner is injected, which is
 * what makes every branch testable off the host that has the command. pi exposes no clipboard API
 * and pi-tui writes no OSC 52, so a subprocess is the only route.
 */

import { spawn } from "node:child_process";

export interface HostCommand {
  command: string;
  args: string[];
}

export interface HostResult {
  ok: boolean;
  /** Why it failed, for a toast. Absent on success. */
  reason?: string;
}

/** Candidate clipboard writers, tried in order: Wayland first, then X11. */
export function copyCommands(platform: NodeJS.Platform = process.platform): HostCommand[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  if (platform === "linux") {
    return [
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
    ];
  }
  return [];
}

/** Opening a directory, not selecting a file: `xdg-open` has no select, so the three stay in step. */
export function openFolderCommand(path: string, platform: NodeJS.Platform = process.platform): HostCommand | undefined {
  if (platform === "darwin") return { command: "open", args: [path] };
  if (platform === "win32") return { command: "explorer", args: [path] };
  if (platform === "linux") return { command: "xdg-open", args: [path] };
  return undefined;
}

export interface RanCommand {
  code: number | null;
  /** The spawn failure, when the command could not run at all (usually: not installed). */
  error?: string;
}

/** Injected by tests; the real one spawns a child and feeds it `stdin`. */
export type HostSpawner = (command: string, args: string[], stdin?: string) => Promise<RanCommand>;

/**
 * The real spawner, exported so the pipe behavior is testable without a fake.
 *
 * The stdin stream needs its own `error` listener: a writer that exits before draining stdin (a clipboard
 * command with no display to talk to) raises `EPIPE` on the stream, and an unhandled stream error is thrown
 * into the event loop, which takes pi down mid-turn. The failure then falls out as a failed candidate.
 */
export const spawnHostCommand: HostSpawner = (command, args, stdin) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"],
    });
    child.stdin?.on("error", () => {
      /* the exit code or `close` reports the failure */
    });
    child.once("error", (error) => resolve({ code: null, error: error.message }));
    child.once("close", (code) => resolve({ code }));
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

export interface HostDeps {
  platform?: NodeJS.Platform;
  spawn?: HostSpawner;
}

/** Put `text` on the clipboard, trying each writer the platform has until one succeeds. */
export async function copyText(text: string, deps: HostDeps = {}): Promise<HostResult> {
  const platform = deps.platform ?? process.platform;
  const run = deps.spawn ?? spawnHostCommand;
  const candidates = copyCommands(platform);
  if (candidates.length === 0) return { ok: false, reason: `no clipboard command known for ${platform}` };
  const failures: string[] = [];
  for (const candidate of candidates) {
    const result = await run(candidate.command, candidate.args, text);
    if (result.error === undefined && result.code === 0) return { ok: true };
    failures.push(`${candidate.command}: ${result.error ?? `exit ${result.code}`}`);
  }
  return { ok: false, reason: failures.join("; ") };
}

/** Show `path` in the platform's file manager. */
export async function openFolder(path: string, deps: HostDeps = {}): Promise<HostResult> {
  const platform = deps.platform ?? process.platform;
  const run = deps.spawn ?? spawnHostCommand;
  const command = openFolderCommand(path, platform);
  if (!command) return { ok: false, reason: `no file manager command known for ${platform}` };
  const result = await run(command.command, command.args);
  if (result.error === undefined && result.code === 0) return { ok: true };
  return { ok: false, reason: `${command.command}: ${result.error ?? `exit ${result.code}`}` };
}
