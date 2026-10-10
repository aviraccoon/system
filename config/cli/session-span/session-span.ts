#!/usr/bin/env bun

// session-span — measure pi session spans. Runs under bun.

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { localDay, renderJson, renderText, shiftDay, zonedEpoch } from "./format";
import { buildReport, groupLineages, type LineageReport, parseSessionFile } from "./sessions";

const HELP = `session-span — measure pi session spans

usage: session-span [--project <name>] [--date today|YYYY-MM-DD] [--since <t>] [--until <t>]

selects sessions whose rows fall on the day (default: today) and reports, per
conversation: files, rows, first/last, span, gaps ≥ --report minutes classified
as work/idle/unknown, and active time.

flags:
  --project <name>      only session dirs whose name contains <name>
  --file <path>         explicit session file (repeatable; skips discovery)
  --session-dir <dir>   sessions root (default: $PI_SESSION_DIR or ~/.pi/agent/sessions)
  --date <d>            today (default) or YYYY-MM-DD
  --idle <minutes>      gap length that counts as idle (default 15)
  --report <minutes>    shortest gap listed (default 5)
  --since <t>           keep rows from t on; HH:MM[:SS] on the report day or a local datetime
  --until <t>           keep rows up to t; same forms as --since
  --json                machine-readable output
  -h, --help            this help
`;

export interface Cli {
  project?: string;
  files: string[];
  sessionDir?: string;
  date?: string;
  idle: number;
  report: number;
  since?: string;
  until?: string;
  json: boolean;
  help: boolean;
}

export interface Deps {
  listDirs(root: string): string[];
  listFiles(dir: string): string[];
  readFile(path: string): string;
  now: Date;
  sessionRoot: string;
  timeZone?: string;
}

export interface RunResult {
  text: string;
  json: unknown;
  code: number;
  jsonMode: boolean;
}

/** Strict parse; throws on unknown flags or bad values. Exported for tests. */
export function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      file: { type: "string", multiple: true },
      "session-dir": { type: "string" },
      date: { type: "string" },
      idle: { type: "string" },
      report: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const date = values.date;
  if (date !== undefined && date !== "today" && !(DAY.test(date) && validDay(date))) {
    throw new Error(`--date must be today or yyyy-mm-dd, got "${date}"`);
  }
  const idle = values.idle === undefined ? 15 : positiveNumber("--idle", values.idle);
  const report = values.report === undefined ? 5 : positiveNumber("--report", values.report);
  for (const [flag, value] of [
    ["--since", values.since],
    ["--until", values.until],
  ] as const) {
    if (value === undefined) continue;
    const clockPart = CLOCK.test(value) ? value : DATETIME.test(value) ? (value.split("T")[1] ?? "") : null;
    const dayPart = clockPart === null ? null : (value.split("T")[0] ?? "");
    if (clockPart === null || !validClock(clockPart) || (dayPart !== null && dayPart !== value && !validDay(dayPart))) {
      throw new Error(`${flag} must be HH:MM[:SS] or YYYY-MM-DDTHH:MM[:SS], got "${value}"`);
    }
  }
  return {
    project: values.project,
    files: values.file ?? [],
    sessionDir: values["session-dir"],
    date,
    idle,
    report,
    since: values.since,
    until: values.until,
    json: values.json ?? false,
    help: values.help ?? false,
  };
}

const CLOCK = /^\d{1,2}:\d{2}(:\d{2})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(:\d{2})?$/;

function validDay(day: string): boolean {
  const [year, month, date] = day.split("-").map(Number);
  const yearNumber = year ?? 0;
  const monthNumber = month ?? 0;
  const dateNumber = date ?? 0;
  if (yearNumber < 1970 || monthNumber < 1 || monthNumber > 12 || dateNumber < 1 || dateNumber > 31) return false;
  const roundTrip = new Date(Date.UTC(yearNumber, monthNumber - 1, dateNumber));
  return (
    roundTrip.getUTCFullYear() === yearNumber &&
    roundTrip.getUTCMonth() === monthNumber - 1 &&
    roundTrip.getUTCDate() === dateNumber
  );
}

function validClock(value: string): boolean {
  const [hour, minute, second] = value.split(":").map(Number);
  return (hour ?? 0) <= 23 && (minute ?? 0) <= 59 && (second ?? 0) <= 59;
}

function positiveNumber(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive number, got "${raw}"`);
  return value;
}

/** Session files for the target day, from explicit paths or directory discovery. */
export function discoverFiles(deps: Deps, cli: Cli, day: string): string[] {
  if (cli.files.length > 0) return [...cli.files];
  const root = cli.sessionDir ?? deps.sessionRoot;
  const lowered = cli.project?.toLowerCase();
  // The filename stamp is the open time in UTC, so a local day's file can be
  // stamped the UTC day before (east of UTC) or after (west of UTC) it.
  const wantedDays = new Set([shiftDay(day, -1), day, shiftDay(day, 1)]);
  const files: string[] = [];
  for (const dir of deps.listDirs(root)) {
    if (lowered !== undefined && !dir.toLowerCase().includes(lowered)) continue;
    for (const name of deps.listFiles(join(root, dir))) {
      if (!name.endsWith(".jsonl")) continue;
      if (!wantedDays.has(name.slice(0, 10))) continue;
      files.push(join(root, dir, name));
    }
  }
  return files.sort();
}

/** The day being reported: an explicit `--date` (`today` included), or the local day now. */
export function resolveDay(deps: Deps, cli: Cli): { day: string; explicit: boolean } {
  const today = localDay(deps.now.getTime(), deps.timeZone);
  if (cli.date === undefined) return { day: today, explicit: false };
  return { day: cli.date === "today" ? today : cli.date, explicit: true };
}

/** Resolves `--since`/`--until` to instants on the report day. */
function resolveWindow(deps: Deps, cli: Cli, day: string): { since?: number; until?: number } {
  const resolve = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (CLOCK.test(value)) return zonedEpoch(day, value, deps.timeZone);
    const [date, time] = value.split("T") as [string, string];
    return zonedEpoch(date, time, deps.timeZone);
  };
  const since = resolve(cli.since);
  const until = resolve(cli.until);
  if (since !== undefined && until !== undefined && until < since) {
    throw new Error("--until is before --since");
  }
  return { since, until };
}

export interface Analysis {
  reports: LineageReport[];
  /** The day/file selection matched rows; only then can the window be the reason none are left. */
  matchedBeforeWindow: boolean;
}

export function analyze(deps: Deps, cli: Cli): Analysis {
  const { day, explicit } = resolveDay(deps, cli);
  const { since, until } = resolveWindow(deps, cli, day);
  const files = discoverFiles(deps, cli, day).map((path) => parseSessionFile(path, deps.readFile(path)));
  const lineages = groupLineages(files);
  // Explicit files are the selection; without --date they are reported as given.
  const daySelected =
    cli.files.length > 0 && !explicit
      ? lineages
      : lineages.filter((lineage) => lineage.rows.some((row) => localDay(row.time, deps.timeZone) === day));
  const matchedBeforeWindow = daySelected.some((lineage) => lineage.rows.length > 0);
  const reports = daySelected
    .map((lineage) =>
      since === undefined && until === undefined
        ? lineage
        : {
            ...lineage,
            rows: lineage.rows.filter(
              (row) => (since === undefined || row.time >= since) && (until === undefined || row.time <= until),
            ),
          },
    )
    .filter((lineage) => lineage.rows.length > 0)
    .map((lineage) => buildReport(lineage, { idleMinutes: cli.idle, now: deps.now.getTime() }));
  return { reports, matchedBeforeWindow };
}

export function run(argv: string[], deps: Deps): RunResult {
  // Read before parsing so every outcome — including a flag error — can honor it.
  const jsonMode = argv.includes("--json");
  let cli: Cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `error: ${message}`, json: { error: message }, code: 1, jsonMode };
  }
  if (cli.help) return { text: HELP, json: { help: HELP }, code: 0, jsonMode: false };
  try {
    const { reports, matchedBeforeWindow } = analyze(deps, cli);
    if (reports.length === 0) {
      const { day, explicit } = resolveDay(deps, cli);
      let text: string;
      if ((cli.since !== undefined || cli.until !== undefined) && matchedBeforeWindow) {
        text = "no rows inside the --since/--until window";
      } else if (cli.files.length > 0 && !explicit) {
        text = "no sessions in the given files";
      } else {
        text = `no sessions on ${day}`;
      }
      return {
        text,
        json: renderJson([], { timeZone: deps.timeZone, reportMinutes: cli.report }),
        code: 1,
        jsonMode,
      };
    }
    return {
      text: renderText(reports, { timeZone: deps.timeZone, reportMinutes: cli.report }),
      json: renderJson(reports, { timeZone: deps.timeZone, reportMinutes: cli.report }),
      code: 0,
      jsonMode,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { text: `error: ${message}`, json: { error: message }, code: 1, jsonMode };
  }
}

const realDeps: Deps = {
  listDirs: (root) =>
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  listFiles: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf8"),
  now: new Date(),
  sessionRoot: process.env.PI_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions"),
};

if (import.meta.main) {
  const result = run(process.argv.slice(2), realDeps);
  console.log(result.jsonMode ? JSON.stringify(result.json, null, 2) : result.text);
  process.exit(result.code);
}
