// One collector per kind of device. A device that runs raccache is asked for its
// own status as JSON; a device that runs its own scripts is read through
// remote.sh with the unit=log pairs from the controller's devices.toml. What to
// report on a device stays machine-local there:
//   ~/.config/raccache/status-targets  remote paths to size
//   ~/.config/raccache/pause           pause marker

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Device, loadMachine, paths } from "./config";
import { fmtIn, parseCollector, parseRunProgress, parseTransferLine, type SideState } from "./format";
import { pairLabels } from "./run";

function run(command: string, args: string[], options: { input?: string; timeout?: number } = {}): string | null {
  try {
    const out = execFileSync(command, args, {
      encoding: "utf8",
      timeout: options.timeout ?? 30_000,
      input: options.input,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

function remoteScript(): string {
  return readFileSync(join(dirname(realpathSync(import.meta.path)), "remote.sh"), "utf8");
}

function sshArgs(host: string, command: string): string[] {
  return ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command];
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** A device whose jobs are systemd units, read through remote.sh. */
export function collectSystemd(device: Device): SideState {
  const at = Date.now();
  const label = `${device.name} (systemd)`;
  const unitSpec = device.units.map((entry) => `${entry.unit}=${entry.log}`).join(",");
  const out = run("ssh", sshArgs(device.ssh ?? "", `RACCACHE_UNITS=${shellQuote(unitSpec)} bash -s`), {
    input: remoteScript(),
    timeout: 120_000,
  });
  if (out === null) return { label, paused: false, targets: [], info: [], error: "ssh failed", at };

  const parsed = parseCollector(out);
  const info: string[] = [];
  const unitStates = Object.entries(parsed.units)
    .map(([name, state]) => `${name}=${state || "unknown"}`)
    .join("  ");
  if (unitStates) info.push(`units  ${unitStates}`);
  const timers = Object.entries(parsed.timers)
    .map(([name, epoch]) => (epoch === undefined ? `${name} —` : `${name} in ${fmtIn(epoch, at)}`))
    .join("  ");
  if (timers) info.push(`next   ${timers}`);
  const unitsActive = Object.values(parsed.units).some((state) => state === "activating" || state === "active");
  if (unitsActive) {
    for (const [name, line] of Object.entries(parsed.progress)) {
      const live = parseTransferLine(line);
      if (live) info.push(`live   ${name}: ${live}`);
    }
  }
  for (const note of parsed.notes) info.push(`note   ${note}`);
  const logs = Object.entries(parsed.logs)
    .filter(([, line]) => line && line !== "-")
    .map(([name, line]) => `${name}: ${line}`)
    .join(" | ");

  return {
    label,
    paused: parsed.paused,
    targets: parsed.sizes,
    info,
    lastLog: logs || undefined,
    at,
    sampled: parsed.sampled === undefined ? undefined : parsed.sampled * 1000,
  };
}

/** A device that runs raccache itself: ask it for its own local status. */
export function collectRemote(device: Device): SideState {
  const at = Date.now();
  const label = `${device.name} (remote)`;
  const out = run("ssh", sshArgs(device.ssh ?? "", "raccache status --json"), { timeout: 60_000 });
  if (out === null) return { label, paused: false, targets: [], info: [], error: "ssh failed", at };
  try {
    const parsed = JSON.parse(out) as { devices?: Array<{ local?: boolean; state?: SideState }> };
    const entry = (parsed.devices ?? []).find((candidate) => candidate.local) ?? parsed.devices?.[0];
    if (!entry?.state) return { label, paused: false, targets: [], info: [], error: "no local status reported", at };
    return { ...entry.state, label, at };
  } catch {
    return { label, paused: false, targets: [], info: [], error: "unreadable status json", at };
  }
}

/** Matches the runner however it was started (`raccache.ts run` or the `~/.local/bin/raccache` symlink). */
export const RUNNER_PATTERN = "raccache(\\.ts)? run";

/** Dispatch on what the device row says it is. */
export function collectDevice(device: Device): SideState {
  if (device.local) return collectLocal();
  if (device.units.length > 0) return collectSystemd(device);
  return collectRemote(device);
}

/** The pass line belongs in `status` only while a runner is alive. */
export function showRunProgress(runnerPid: string | null, plan: string[]): boolean {
  return Boolean(runnerPid) && plan.length > 0;
}

export function collectLocal(): SideState {
  const at = Date.now();
  const p = paths();
  const host = run("hostname", ["-s"]) ?? "unknown";
  const label = `this machine (${host})`;
  const paused = existsSync(p.pause);
  const info: string[] = [];

  if (process.platform === "darwin") {
    const launchdList = run("launchctl", ["list", "org.nixos.raccache"]);
    if (launchdList) {
      const lastExit = /"LastExitStatus"\s*=\s*(\d+)/.exec(launchdList)?.[1];
      const pid = /"PID"\s*=\s*(\d+)/.exec(launchdList)?.[1];
      const state = pid ? `running (pid ${pid})` : "idle";
      info.push(`launchd  ${state}${lastExit === undefined ? "" : ` · last exit ${lastExit}`}`);
    } else {
      info.push("launchd  not loaded (nix switch pending?)");
    }
  } else if (process.platform === "linux") {
    const active = run("systemctl", ["--user", "is-active", "raccache.service"]);
    if (active) info.push(`systemd  ${active}`);
  }

  const runnerPid = run("pgrep", ["-f", RUNNER_PATTERN]);
  const rclonePid = run("pgrep", ["-f", "rclone sync"]);
  const machine = loadMachine(p);
  const plan = pairLabels(machine.targets, machine.destinations);
  // Only while a runner is alive: a killed pass leaves no `raccache done` line, so
  // an elapsed pair with nothing running would read as a hung backup.
  if (showRunProgress(runnerPid, plan)) {
    try {
      const progress = parseRunProgress(readFileSync(p.log, "utf8"), plan);
      if (progress) info.push(`run     ${progress}`);
    } catch {
      // no log yet
    }
  }
  if (runnerPid || rclonePid) info.push(`running  run=${runnerPid ?? "-"} rclone=${rclonePid ?? "-"}`);

  if (runnerPid || rclonePid) {
    // Read a bounded tail: the full log can exceed execFileSync's capture limit.
    const lines = run("tail", ["-n", "200", p.log])?.split("\n") ?? [];
    const transfers = lines.filter((line) => line.startsWith("Transferred:"));
    const live = parseTransferLine(transfers.findLast((line) => line.includes("ETA")) ?? transfers.at(-1));
    if (live) info.push(`live   ${live}`);
  }

  const lastLog = run("tail", ["-n1", p.log]);
  return { label, paused, targets: [], info, lastLog: lastLog ?? undefined, at };
}
