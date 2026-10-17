// Machine-local configuration for raccache: where its files live, the
// key=value settings file, and the target manifest. Everything a machine
// needs to describe its own backup job lives in ~/.config/raccache/ and
// nothing here is committed to the repo.

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, posix, sep } from "node:path";

// Included even when a repo's .gitignore excludes them: local-only files that
// cannot be regenerated. `.env` covers the family (`.env.local`, ...).
export const DEFAULT_INCLUDE = ["AGENTS.local.md", "CLAUDE.local.md", ".env", ".env.*", "mise.local.toml"];

// Glob patterns excluded from every target, at any depth. Regenerable build
// artifacts; repos with their own .gitignore get these from git instead.
export const DEFAULT_EXCLUDE = [
  ".DS_Store",
  "node_modules/**",
  "target/**",
  ".venv/**",
  "venv/**",
  ".direnv/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".turbo/**",
  ".cache/**",
];

export const DEFAULT_BW_LIMIT = "63M";

export interface Target {
  /** Directory under a destination root, e.g. "dev". */
  dest: string;
  /** Absolute source path (~ expanded). */
  src: string;
  /** Exclude what the repos' .gitignore files exclude (plus exceptions). */
  gitignore: boolean;
}

/** Where targets are mirrored. Every target goes to every destination. */
export interface Destination {
  name: string;
  /** rclone target root; `{host}` expands to the short hostname. */
  remote: string;
  /** `mirror` also deletes (with --delete-excluded), `copy` only ever adds. */
  mode: "mirror" | "copy";
  /** Extra rclone flags for this destination's provider quirks. */
  flags: string[];
}

/** A machine `status` and the controls can reach. */
export interface Device {
  name: string;
  local: boolean;
  ssh?: string;
  /** systemd units to report for a device that runs its own backup scripts. */
  units: Array<{ unit: string; log: string }>;
}

export interface Settings {
  homeGateway?: string;
  powerGuard: boolean;
  bwLimit: string;
  rclone: string;
  git: string;
  include: string[];
  exclude: string[];
}

export function configDir(home = homedir()): string {
  return process.env.RACCACHE_CONFIG_DIR ?? join(home, ".config/raccache");
}

export function logPath(platform = process.platform, home = homedir()): string {
  if (process.env.RACCACHE_LOG) return process.env.RACCACHE_LOG;
  if (platform === "darwin") return join(home, "Library/Logs/raccache.log");
  const state = process.env.XDG_STATE_HOME ?? join(home, ".local/state");
  return join(state, "raccache/raccache.log");
}

export function envOrSetting(env: string, fallback: string): string {
  return process.env[env] ?? fallback;
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** Parse the key=value settings file. Unknown keys are reported, not fatal. */
export function parseSettings(
  text: string,
  defaults: Partial<Settings> = {},
): { settings: Partial<Settings>; warnings: string[] } {
  const settings: Partial<Settings> = { ...defaults };
  const warnings: string[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) {
      warnings.push(`config line ${index + 1}: not KEY=value`);
      continue;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "HOME_GATEWAY":
        settings.homeGateway = value;
        break;
      case "POWER_GUARD":
        settings.powerGuard = value !== "0" && value !== "false";
        break;
      case "BW_LIMIT":
        settings.bwLimit = value;
        break;
      case "RCLONE":
        settings.rclone = value;
        break;
      case "GIT":
        settings.git = value;
        break;
      case "INCLUDE":
        settings.include = value.split(/\s+/).filter(Boolean);
        break;
      case "EXCLUDE":
        settings.exclude = value.split(/\s+/).filter(Boolean);
        break;
      default:
        warnings.push(`config line ${index + 1}: unknown key '${key}'`);
    }
  }
  return { settings, warnings };
}

export function loadSettings(configDirPath = configDir()): { settings: Settings; warnings: string[] } {
  const file = join(configDirPath, "config");
  const parsed = existsSync(file) ? parseSettings(readFileSync(file, "utf8")) : { settings: {}, warnings: [] };
  const settings: Settings = {
    homeGateway: parsed.settings.homeGateway,
    powerGuard: parsed.settings.powerGuard ?? true,
    bwLimit: parsed.settings.bwLimit ?? DEFAULT_BW_LIMIT,
    rclone: parsed.settings.rclone ?? envOrSetting("RCLONE", "rclone"),
    git: parsed.settings.git ?? envOrSetting("GIT", "git"),
    include: parsed.settings.include ?? DEFAULT_INCLUDE,
    exclude: parsed.settings.exclude ?? DEFAULT_EXCLUDE,
  };
  return { settings, warnings: parsed.warnings };
}

/** `~/.config/raccache/env`: KEY=value lines, written by sops-nix or by hand. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (key) env[key] = value;
  }
  return env;
}

export function loadEnvFile(file: string): Record<string, string> {
  return existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
}

/**
 * Where sops-nix renders the rclone credentials (RCLONE_CONFIG_* values) and
 * the ntfy URL. The machine-local env file is read on top, so an unmanaged
 * machine can override any value by hand.
 */
export const SECRETS_ENV = "/run/secrets/raccache.env";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate one target table; returns an error string when it is unusable. */
export function validateTarget(raw: unknown, home = homedir()): { target?: Target; error?: string } {
  if (!isPlainObject(raw)) return { error: "target must be a table" };
  const known = new Set(["dest", "src", "gitignore"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { error: `unknown field '${key}'` };
  }
  const dest = raw.dest;
  if (typeof dest !== "string" || !dest) return { error: "missing 'dest'" };
  if (dest.startsWith("/") || dest.includes("\\")) return { error: `dest '${dest}' must be a relative path` };
  const parts = dest.split("/");
  if (parts.some((part) => !part || part === "." || part === ".."))
    return { error: `dest '${dest}' has an empty or relative segment` };
  const src = raw.src;
  if (typeof src !== "string" || !src) return { error: "missing 'src'" };
  const expanded = expandHome(src, home);
  if (!expanded.startsWith("/")) return { error: `src '${src}' must be absolute or start with ~/` };
  if (raw.gitignore !== undefined && typeof raw.gitignore !== "boolean")
    return { error: "'gitignore' must be true or false" };
  return { target: { dest, src: expanded, gitignore: raw.gitignore === true } };
}

/** Read and validate the TOML manifest of what this machine mirrors. */
export function parseTargets(text: string, home = homedir()): { targets: Target[]; errors: string[] } {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (error) {
    return { targets: [], errors: [`targets.toml: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isPlainObject(doc)) return { targets: [], errors: ["targets.toml: expected a table"] };
  const raw = doc.target;
  if (raw === undefined) return { targets: [], errors: ["targets.toml: no [[target]] entries"] };
  if (!Array.isArray(raw)) return { targets: [], errors: ["targets.toml: 'target' must be an array of tables"] };
  const targets: Target[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const { target, error } = validateTarget(entry, home);
    if (error || !target) {
      errors.push(`target ${index + 1}: ${error}`);
      continue;
    }
    if (seen.has(target.dest)) {
      errors.push(`target ${index + 1}: duplicate dest '${target.dest}'`);
      continue;
    }
    seen.add(target.dest);
    targets.push(target);
  }
  return { targets, errors };
}

/** One destination table; `{host}` is the short hostname, so every machine keeps its own directory. */
export function validateDestination(raw: unknown, host: string): { destination?: Destination; error?: string } {
  if (!isPlainObject(raw)) return { error: "destination must be a table" };
  const known = new Set(["name", "remote", "mode", "flags"]);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) return { error: `unknown field '${key}'` };
  }
  const name = raw.name;
  if (typeof name !== "string" || !name) return { error: "missing 'name'" };
  const remote = raw.remote;
  if (typeof remote !== "string" || !remote.includes(":"))
    return { error: `remote '${String(remote)}' must look like remote:path` };
  if (raw.mode !== undefined && raw.mode !== "mirror" && raw.mode !== "copy") {
    return { error: "'mode' must be 'mirror' or 'copy'" };
  }
  if (raw.flags !== undefined && (!Array.isArray(raw.flags) || raw.flags.some((flag) => typeof flag !== "string"))) {
    return { error: "'flags' must be an array of strings" };
  }
  return {
    destination: {
      name,
      remote: remote.replaceAll("{host}", host),
      mode: raw.mode === "copy" ? "copy" : "mirror",
      flags: Array.isArray(raw.flags) ? (raw.flags as string[]) : [],
    },
  };
}

function parseTables(file: string, key: string): { rows: unknown[]; errors: string[] } {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(file);
  } catch (error) {
    return { rows: [], errors: [`${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!isPlainObject(doc)) return { rows: [], errors: ["expected a table"] };
  const rows = doc[key];
  if (rows === undefined) return { rows: [], errors: [`no [[${key}]] entries`] };
  if (!Array.isArray(rows)) return { rows: [], errors: [`'${key}' must be an array of tables`] };
  return { rows, errors: [] };
}

export function parseDestinations(text: string, host: string): { destinations: Destination[]; errors: string[] } {
  const parsed = parseTables(text, "destination");
  const destinations: Destination[] = [];
  const errors = [...parsed.errors];
  const seen = new Set<string>();
  for (const [index, row] of parsed.rows.entries()) {
    const { destination, error } = validateDestination(row, host);
    if (error || !destination) {
      errors.push(`destination ${index + 1}: ${error}`);
      continue;
    }
    if (seen.has(destination.name)) {
      errors.push(`destination ${index + 1}: duplicate name '${destination.name}'`);
      continue;
    }
    seen.add(destination.name);
    destinations.push(destination);
  }
  return { destinations, errors };
}

export function parseDevices(text: string): { devices: Device[]; errors: string[] } {
  const parsed = parseTables(text, "device");
  const devices: Device[] = [];
  const errors = [...parsed.errors];
  const seen = new Set<string>();
  for (const [index, row] of parsed.rows.entries()) {
    if (!isPlainObject(row)) {
      errors.push(`device ${index + 1}: device must be a table`);
      continue;
    }
    for (const key of Object.keys(row)) {
      if (!["name", "local", "ssh", "units"].includes(key)) errors.push(`device ${index + 1}: unknown field '${key}'`);
    }
    const name = row.name;
    if (typeof name !== "string" || !name) {
      errors.push(`device ${index + 1}: missing 'name'`);
      continue;
    }
    const local = row.local === true;
    const ssh = typeof row.ssh === "string" && row.ssh ? row.ssh : undefined;
    if (local === Boolean(ssh)) {
      errors.push(`device ${index + 1}: set either 'local = true' or 'ssh = "host"'`);
      continue;
    }
    const units: Array<{ unit: string; log: string }> = [];
    if (row.units !== undefined) {
      if (!Array.isArray(row.units)) {
        errors.push(`device ${index + 1}: 'units' must be an array of tables`);
        continue;
      }
      for (const entry of row.units) {
        if (!isPlainObject(entry) || typeof entry.unit !== "string" || typeof entry.log !== "string") {
          errors.push(`device ${index + 1}: each unit needs 'unit' and 'log' strings`);
          continue;
        }
        units.push({ unit: entry.unit, log: entry.log });
      }
    }
    if (seen.has(name)) {
      errors.push(`device ${index + 1}: duplicate name '${name}'`);
      continue;
    }
    seen.add(name);
    devices.push({ name, local, ssh, units });
  }
  return { devices, errors };
}

/** This machine's own device entry, used when no devices.toml exists. */
export function localDevice(name = hostname().split(".")[0]): Device {
  return { name, local: true, units: [] };
}

/** Everything one machine needs: settings, targets, destinations, devices, secrets. */
export interface Machine {
  paths: Paths;
  settings: Settings;
  targets: Target[];
  destinations: Destination[];
  devices: Device[];
  env: Record<string, string>;
  warnings: string[];
  errors: string[];
}

export function loadMachine(p: Paths, home = homedir()): Machine {
  const { settings, warnings } = loadSettings(p.dir);
  const errors: string[] = [];
  const read = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, "utf8") : undefined);

  const targetsText = read(p.targets);
  const targets = targetsText === undefined ? { targets: [], errors: [] } : parseTargets(targetsText, home);
  if (targetsText === undefined) errors.push(`no target manifest at ${p.targets}`);
  errors.push(...targets.errors);

  const destinationsText = read(p.destinations);
  const destinations =
    destinationsText === undefined
      ? { destinations: [], errors: [] }
      : parseDestinations(destinationsText, hostname().split(".")[0]);
  if (destinationsText === undefined) errors.push(`no destination manifest at ${p.destinations}`);
  errors.push(...destinations.errors);

  const devicesText = read(p.devices);
  const devices = devicesText === undefined ? { devices: [localDevice()], errors: [] } : parseDevices(devicesText);
  errors.push(...devices.errors);

  return {
    paths: p,
    settings,
    targets: targets.targets,
    destinations: destinations.destinations,
    devices: devices.devices,
    env: { ...loadEnvFile(SECRETS_ENV), ...loadEnvFile(p.env) },
    warnings,
    errors,
  };
}

export interface Paths {
  dir: string;
  config: string;
  targets: string;
  destinations: string;
  devices: string;
  env: string;
  ignore: string;
  pause: string;
  lock: string;
  ntfy: string;
  log: string;
}

/** All machine-local files raccache reads or writes. */
export function paths({
  home = homedir(),
  platform = process.platform,
  dir = configDir(home),
}: {
  home?: string;
  platform?: NodeJS.Platform;
  dir?: string;
} = {}): Paths {
  return {
    dir,
    config: join(dir, "config"),
    targets: join(dir, "targets.toml"),
    destinations: join(dir, "destinations.toml"),
    devices: join(dir, "devices.toml"),
    env: join(dir, "env"),
    ignore: join(dir, "ignore"),
    pause: join(dir, "pause"),
    lock: join(dir, "lock"),
    ntfy: join(dir, "ntfy-url"),
    log: logPath(platform, home),
  };
}

/** Paths in the machine config are written with `/`; normalize for the OS. */
export function toHostPath(path: string): string {
  return sep === "/" ? path : path.split(posix.sep).join(sep);
}
