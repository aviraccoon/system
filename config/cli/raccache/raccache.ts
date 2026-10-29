#!/usr/bin/env bun

// raccache — offsite backup for this machine: the scheduled run, the filter
// files it mirrors with, and a status/control view over every device in
// devices.toml.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  type CliSpec,
  type CommandSpec,
  type FlagSpec,
  type ParsedCli,
  runCli,
  parseCli as sharedParseCli,
  UsageError,
} from "../../shared/cli";
import { collectDevice, RUNNER_PATTERN } from "./collect";
import { type Device, loadMachine, paths } from "./config";
import { computeRates, renderSide, type SideState } from "./format";
import { generateFilter, runBackup } from "./run";

const FLAGS: FlagSpec[] = [
  {
    key: "dry-run",
    type: "boolean",
    synopsis: "[--dry-run]",
    usage: "--dry-run",
    help: "run: pass --dry-run to rclone, upload nothing",
  },
  {
    key: "only",
    type: "string",
    synopsis: "[--only <t>]",
    usage: "--only <target>",
    help: "run: restrict to one target",
  },
  {
    key: "destination",
    type: "string",
    synopsis: "[--destination <d>]",
    usage: "--destination <name>",
    help: "run: restrict to one destination",
  },
  {
    key: "path",
    type: "string",
    multiple: true,
    synopsis: "[--path <p>]...",
    usage: "--path <pattern>",
    help: "run, filters: only these paths (relative to the target's root); repeatable; a trailing slash means the whole subtree",
  },
  {
    key: "device",
    type: "string",
    multiple: true,
    synopsis: "[--device <d>]...",
    usage: "--device <name>",
    help: "status, pause, resume, stop: restrict to one device (repeatable)",
  },
  {
    key: "watch",
    type: "boolean",
    short: "w",
    synopsis: "[--watch]",
    usage: "-w, --watch",
    help: "status: refresh continuously and show rates",
  },
  {
    key: "interval",
    type: "string",
    synopsis: "[--interval <s>]",
    usage: "--interval <s>",
    help: "status: refresh interval in seconds (default 30)",
  },
  { key: "json", type: "boolean", synopsis: "[--json]", usage: "--json", help: "status: one snapshot as JSON" },
  { key: "help", type: "boolean", short: "h", global: true, usage: "-h, --help", help: "this help" },
];

const COMMANDS: CommandSpec<void, number, Cli>[] = [
  {
    name: "run",
    args: "run",
    summary: "mirror every target to every destination; the scheduled job",
    flags: ["dry-run", "only", "destination", "path"],
    handler: {
      min: 0,
      max: 0,
      run: async (_ctx, _args, cli) =>
        runBackup({ dryRun: cli.dryRun, only: cli.only, destination: cli.destination, path: cli.path }),
    },
  },
  {
    name: "status",
    args: "status",
    summary: "progress, timers and the last log line, per device",
    flags: ["watch", "interval", "json", "device"],
    handler: { min: 0, max: 0, run: async (_ctx, _args, cli) => status(cli) },
  },
  {
    name: "pause",
    args: "pause",
    summary: "create the pause file so future runs skip",
    flags: ["device"],
    handler: { min: 0, max: 0, run: (_ctx, _args, cli) => controlAll("pause", cli) },
  },
  {
    name: "resume",
    args: "resume",
    summary: "remove the pause file",
    flags: ["device"],
    handler: { min: 0, max: 0, run: (_ctx, _args, cli) => controlAll("resume", cli) },
  },
  {
    name: "stop",
    args: "stop",
    summary: "stop in-flight jobs",
    flags: ["device"],
    handler: { min: 0, max: 0, run: (_ctx, _args, cli) => controlAll("stop", cli) },
  },
  {
    name: "filters",
    args: "filters [<target>]",
    summary: "print the generated rclone filters for a target",
    flags: ["path"],
    handler: { min: 0, max: 1, run: async (_ctx, _args, cli) => printFilters(cli) },
  },
];

const SPEC: CliSpec<void, number, Cli> = {
  name: "raccache",
  summary: "offsite backup",
  intro: `mirrors the targets in ~/.config/raccache/targets.toml to every destination in
destinations.toml, and shows what this machine and the other devices in
devices.toml are doing right now.

config (~/.config/raccache/): config, targets.toml, destinations.toml,
devices.toml, ignore, env, pause, ntfy-url. \`raccache filters\` shows the rules
a run would use.`,
  flags: FLAGS,
  commands: COMMANDS,
  default: "status",
};

/** Typed view the handlers consume; `--interval` is validated here. */
export interface Cli {
  command: string;
  target?: string;
  watch: boolean;
  interval: number;
  devices: string[];
  json: boolean;
  dryRun: boolean;
  only?: string;
  destination?: string;
  path: string[];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Build the typed view; throws `UsageError` on a bad value. */
function toCli(parsed: ParsedCli): Cli {
  const interval = Number(parsed.values.interval ?? "30");
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new UsageError("--interval must be a positive number of seconds");
  }
  return {
    command: parsed.commandPath.at(-1) ?? "status",
    target: parsed.args[0],
    watch: parsed.values.watch === true,
    interval,
    devices: stringList(parsed.values.device),
    json: parsed.values.json === true,
    dryRun: parsed.values["dry-run"] === true,
    only: stringValue(parsed.values.only),
    destination: stringValue(parsed.values.destination),
    path: stringList(parsed.values.path),
  };
}

/** Strict parse; throws on an unknown command or a flag the command does not take. */
export function parseCli(argv: string[]): Cli {
  const parsed = sharedParseCli(SPEC, argv);
  if (parsed.unknown !== undefined) throw new UsageError(`unknown command "${parsed.unknown}"`);
  return toCli(parsed);
}

/** Device rows to act on: everything, or the ones named with --device. */
export function selectDevices(devices: Device[], names: string[]): { devices: Device[]; unknown: string[] } {
  if (names.length === 0) return { devices, unknown: [] };
  const wanted = new Set(names);
  const selected = devices.filter((device) => wanted.has(device.name));
  const unknown = names.filter((name) => !devices.some((device) => device.name === name));
  return { devices: selected, unknown };
}

function unitArgs(device: Device): string[] {
  return device.units.map((entry) => entry.unit);
}

function ssh(host: string, command: string): { ok: boolean; out: string; reason?: "ssh" | "command" } {
  try {
    const out = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, command], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return { ok: true, out: out.trim() };
  } catch (error) {
    // ssh exits 255 on its own failures; any other status came from the remote command.
    const status = (error as { status?: number | null }).status;
    return { ok: false, out: "", reason: typeof status === "number" && status !== 255 ? "command" : "ssh" };
  }
}

function note(device: Device, result: { ok: boolean; reason?: string }, okText: string, failVerb: string): string {
  if (result.ok) return `${device.name}: ${okText}`;
  return result.reason === "command" ? `${device.name}: ${failVerb} failed` : `${device.name}: ssh failed`;
}

export function control(command: string, devices: Device[]): string[] {
  const p = paths();
  const notes: string[] = [];

  for (const device of devices) {
    if (device.local) {
      if (command === "pause") {
        mkdirSync(p.dir, { recursive: true });
        writeFileSync(p.pause, "");
        notes.push(`local: paused (${p.pause})`);
      } else if (command === "resume") {
        if (existsSync(p.pause)) {
          rmSync(p.pause);
          notes.push("local: resumed");
        } else {
          notes.push("local: was not paused");
        }
      } else if (command === "stop") {
        let matched = false;
        for (const pattern of [RUNNER_PATTERN, "rclone sync"]) {
          try {
            execFileSync("pkill", ["-f", pattern]);
            matched = true;
          } catch {
            // nothing matched
          }
        }
        notes.push(matched ? "local: stopped in-flight job(s)" : "local: nothing was running");
      } else if (command === "run") {
        if (existsSync(p.pause)) {
          notes.push("local: paused — not starting (run: raccache resume)");
        } else {
          spawn(process.execPath, [import.meta.path, "run"], { detached: true, stdio: "ignore" }).unref();
          notes.push("local: started");
        }
      }
      continue;
    }

    const host = device.ssh ?? "";
    if (device.units.length > 0) {
      const units = unitArgs(device);
      if (command === "pause") {
        notes.push(
          note(
            device,
            ssh(host, 'mkdir -p "$HOME/.config/raccache" && touch "$HOME/.config/raccache/pause"'),
            "paused",
            "pause",
          ),
        );
      } else if (command === "resume") {
        notes.push(note(device, ssh(host, 'rm -f "$HOME/.config/raccache/pause"'), "resumed", "resume"));
      } else if (command === "stop") {
        notes.push(
          note(
            device,
            ssh(host, `systemctl --user stop ${units.map((u) => `${u}.service`).join(" ")}`),
            "stopped in-flight job(s)",
            "stop",
          ),
        );
      } else if (command === "run") {
        const probe = ssh(host, 'test -e "$HOME/.config/raccache/pause" && echo yes || echo no');
        if (!probe.ok) {
          notes.push(note(device, probe, "", "pause check"));
        } else if (probe.out === "yes") {
          notes.push(`${device.name}: paused — not starting (run: raccache resume)`);
        } else {
          const starts = units.map((u) => `${u}.service`).join(" ");
          notes.push(note(device, ssh(host, `systemctl --user start --no-block ${starts}`), "started", "start"));
        }
      }
      continue;
    }

    // A device that runs raccache: ask it to act on itself.
    if (command === "run") {
      const probe = ssh(host, "command -v raccache >/dev/null 2>&1 && echo ok || echo missing");
      if (!probe.ok) {
        notes.push(note(device, probe, "", "start"));
      } else if (probe.out !== "ok") {
        notes.push(`${device.name}: raccache not installed`);
      } else {
        const result = ssh(host, "nohup raccache run >/dev/null 2>&1 & echo started");
        notes.push(note(device, result, result.out || "started", "start"));
      }
    } else {
      const result = ssh(host, `raccache ${command}`);
      notes.push(note(device, result, result.out || `${command} ok`, command));
    }
  }
  return notes;
}

async function printFilters(cli: Cli): Promise<number> {
  const p = paths();
  const machine = loadMachine(p);
  if (machine.errors.length > 0) {
    for (const error of machine.errors) console.error(`error: ${error}`);
    return 1;
  }
  const selected = cli.target ? machine.targets.filter((entry) => entry.dest === cli.target) : machine.targets;
  if (selected.length === 0) {
    console.error(`error: no target named '${cli.target}'`);
    return 1;
  }
  let rc = 0;
  for (const target of selected) {
    const { file, rules, repoErrors } = generateFilter(target, machine.settings, p, cli.path);
    console.log(`--- ${target.dest}  (${target.src}) → ${file}`);
    for (const warning of repoErrors) console.error(`warn: ${warning}`);
    for (const error of rules.errors) console.error(`error: ${error}`);
    console.log(
      `${rules.stats.gitignore} from ${rules.stats.repos} repos, ${rules.stats.user} from ignore, ` +
        `${rules.stats.include} includes, ${rules.stats.exclude} excludes` +
        `${rules.stats.slice > 0 ? `, ${rules.stats.slice} slice` : ""}`,
    );
    for (const line of rules.lines) console.log(line);
    if (rules.errors.length > 0) rc = 1;
  }
  return rc;
}

function snapshot(devices: Device[]): Array<{ name: string; local: boolean; state: SideState }> {
  return devices.map((device) => ({ name: device.name, local: device.local, state: collectDevice(device) }));
}

async function status(cli: Cli): Promise<number> {
  const p = paths();
  const machine = loadMachine(p);
  const { devices, unknown } = selectDevices(machine.devices, cli.devices);
  for (const name of unknown) console.error(`error: unknown device '${name}'`);
  if (devices.length === 0) return 1;

  const tty = cli.watch && !cli.json && Boolean(process.stdout.isTTY);
  if (tty) {
    // Live dashboard: take over the terminal (alternate screen) so frames never
    // pollute scrollback, and restore it on exit.
    process.stdout.write("\u001b[?1049h");
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(signal, () => {
        process.stdout.write("\u001b[?1049l");
        process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
      });
    }
  }
  let previous = new Map<string, SideState>();
  try {
    for (;;) {
      const current = snapshot(devices);
      if (cli.json) {
        console.log(JSON.stringify({ at: Date.now(), devices: current }, null, 2));
        return 0;
      }
      const blocks = current.map((entry) =>
        renderSide(entry.state, computeRates(previous.get(entry.name), entry.state), new Date()),
      );
      if (tty) process.stdout.write("\u001b[H\u001b[2J");
      console.log(blocks.join("\n\n"));
      if (!cli.watch) return 0;
      previous = new Map(current.map((entry) => [entry.name, entry.state]));
      await Bun.sleep(cli.interval * 1000);
    }
  } finally {
    if (tty) process.stdout.write("\u001b[?1049l");
  }
}

/** Apply a control command to the selected devices; 1 when a name is unknown. */
function controlAll(command: string, cli: Cli): number {
  const { devices, unknown } = selectDevices(loadMachine(paths()).devices, cli.devices);
  for (const name of unknown) console.error(`error: unknown device '${name}'`);
  for (const line of control(command, devices)) console.log(line);
  return unknown.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  return runCli<void, number, Cli>({ spec: SPEC, argv: process.argv.slice(2), adapt: toCli });
}

if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
