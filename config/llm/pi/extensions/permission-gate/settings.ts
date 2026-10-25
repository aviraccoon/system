/**
 * The gate's settings that outlive one pi process.
 *
 * Mode and auto-classify are a preference, not session state: a preference that
 * resets on every start has to be re-entered in every session, and the gate then asks
 * again for calls the user has already decided it should handle. Everything else the
 * gate remembers — path globs, bash prefixes, tool overrides — belongs to the work in
 * front of the user and stays in memory.
 *
 * The file is a preference, never an authorization: it can only select what the
 * keyboard can select, and a missing, unreadable or malformed file leaves the defaults
 * (careful, auto off). Saving is best effort — a gate that cannot record a preference
 * still gates, and the session keeps the choice either way.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AutoClassifyMode, type GateState, MODE_CYCLE, type Mode } from "./logic";

/** What survives a restart. Absent keys keep the state's own default. */
export interface PersistedSettings {
  mode?: Mode;
  autoClassify?: AutoClassifyMode;
}

export function settingsPath(home: string): string {
  return join(home, ".pi", "agent", "state", "permission-gate.json");
}

/** Parse the file's text; anything unrecognized is simply absent. */
export function parseSettings(raw: string): PersistedSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const object = parsed as Record<string, unknown>;
  const settings: PersistedSettings = {};
  if (typeof object.mode === "string" && (MODE_CYCLE as string[]).includes(object.mode)) {
    settings.mode = object.mode as Mode;
  }
  if (object.autoClassify === "on" || object.autoClassify === "off") settings.autoClassify = object.autoClassify;
  return settings;
}

/** Read the file; a missing or unreadable one means "no persisted settings". */
export function loadSettings(file: string): PersistedSettings {
  try {
    return parseSettings(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Write the settings atomically: a reader (the next pi start) sees either the old
 * file or the new one, never a truncated half. Returns whether it landed.
 */
export function saveSettings(file: string, settings: PersistedSettings): boolean {
  const temporary = temporaryPath(file);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
    renameSync(temporary, file);
    return true;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // A leftover staging file is not worth failing the gate over.
    }
    return false;
  }
}

/**
 * Where a save stages its content before the rename. Per writer, not one name for
 * every process: two pi windows saving at once would otherwise truncate the same
 * file, and a failed save's cleanup would delete the other's staging file.
 */
export function temporaryPath(file: string): string {
  return `${file}.tmp-${process.pid}`;
}

/** Merge the persisted pair into the state, leaving the current value where a key is absent. */
export function applySettings(state: GateState, settings: PersistedSettings): void {
  if (settings.mode) state.mode = settings.mode;
  if (settings.autoClassify) state.autoClassify = settings.autoClassify;
}

/** The pair to persist for the state as it stands. */
export function currentSettings(state: GateState): PersistedSettings {
  return { mode: state.mode, autoClassify: state.autoClassify };
}
