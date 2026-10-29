#!/usr/bin/env bun

// harvest — CLI for Harvest time tracking (API v2). Runs under bun.

import { createInterface } from "node:readline";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { createClient, HarvestApiError } from "./api";
import {
  aliasList,
  aliasRemove,
  aliasSet,
  type CmdResult,
  cmdAudit,
  cmdDelete,
  cmdEdit,
  cmdLog,
  cmdMonth,
  cmdProjects,
  cmdResume,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdTasks,
  cmdToday,
  cmdWeek,
  cmdWhoami,
  type Deps,
} from "./commands";
import { DEFAULT_USER_AGENT, loadCache, loadConfig, resolveAuth, saveCache, saveConfig } from "./config";

interface FlagSpec {
  key: string;
  type: "string" | "boolean";
  short?: string;
  /** Every command takes it; rendered globally rather than in a command's flag list. */
  global?: boolean;
  /** Token as it appears in a command synopsis; empty when the usage line lists it. */
  synopsis: string;
  usage: string;
  help: string;
}

const FLAGS: FlagSpec[] = [
  {
    key: "note",
    type: "string",
    short: "n",
    synopsis: "[-n text]",
    usage: "-n, --note <text>",
    help: "note for start/log/edit",
  },
  { key: "date", type: "string", synopsis: "[--date D]", usage: "--date <yyyy-mm-dd>", help: "date for log/edit" },
  {
    key: "from",
    type: "string",
    synopsis: "[--from D --to D]",
    usage: "--from <yyyy-mm-dd>",
    help: "audit range start (with --to)",
  },
  { key: "to", type: "string", synopsis: "", usage: "--to <yyyy-mm-dd>", help: "audit range end (with --from)" },
  {
    key: "days",
    type: "string",
    synopsis: "[--days N]",
    usage: "--days <n>",
    help: "audit: last n days including today",
  },
  { key: "hours", type: "string", synopsis: "[--hours H]", usage: "--hours <hours>", help: "hours for edit" },
  {
    key: "project",
    type: "string",
    synopsis: "[--project P]",
    usage: "--project <query>",
    help: "with edit: project to move the entry to",
  },
  {
    key: "task",
    type: "string",
    synopsis: "[--task T]",
    usage: "--task <query>",
    help: "with edit: task on the target (or current) project",
  },
  {
    key: "offset",
    type: "string",
    synopsis: "[--offset DUR]",
    usage: "--offset <duration>",
    help: "with start: time already spent (25m, 1:30, 1h30m)",
  },
  {
    key: "force",
    type: "boolean",
    short: "f",
    synopsis: "[--force]",
    usage: "-f, --force",
    help: "with delete: skip the confirm prompt",
  },
  {
    key: "group-by",
    type: "string",
    synopsis: "[--group-by DIM]",
    usage: "--group-by <dim>",
    help: "group today/week/month by project|task|note",
  },
  {
    key: "remove",
    type: "boolean",
    short: "r",
    synopsis: "-r <name>",
    usage: "-r, --remove",
    help: "with alias: remove it",
  },
  {
    key: "conceal",
    type: "boolean",
    synopsis: "[--conceal]",
    usage: "--conceal",
    help: "hide money amounts (status/today/week/month)",
  },
  { key: "json", type: "boolean", global: true, synopsis: "", usage: "--json", help: "machine-readable output" },
  { key: "help", type: "boolean", short: "h", global: true, synopsis: "", usage: "-h, --help", help: "this help" },
];

const FLAG_BY_KEY = new Map(FLAGS.map((f) => [f.key, f]));

interface CommandSpec {
  name: string;
  /** Positional part of the synopsis; flags are appended from `flags`. */
  args: string;
  summary: string;
  flags: string[];
}

/** One table for help, per-command flags and the parser's option sets. */
const COMMANDS: CommandSpec[] = [
  { name: "status", args: "status", summary: "running timer + today's entries and total", flags: ["conceal"] },
  {
    name: "start",
    args: "start <project> [<task>]",
    summary: "start a timer (stops the running one)",
    flags: ["note", "offset"],
  },
  { name: "stop", args: "stop", summary: "stop the running timer", flags: [] },
  {
    name: "resume",
    args: "resume [<entry-id>]",
    summary:
      "continue a stopped entry after a pause (default: today's stopped entry touched most recently); stops any running timer and keeps its project, task, note and hours",
    flags: [],
  },
  {
    name: "log",
    args: "log <hours> <project> [<task>]",
    summary: "log past time (1.5, 1:30, 90m)",
    flags: ["note", "date"],
  },
  {
    name: "edit",
    args: "edit <entry-id>",
    summary: "edit an entry; --project/--task move it",
    flags: ["note", "date", "hours", "project", "task"],
  },
  { name: "today", args: "today", summary: "today's entries and total", flags: ["conceal", "group-by"] },
  {
    name: "week",
    args: "week",
    summary: "this ISO week, per-day and per-project totals",
    flags: ["conceal", "group-by"],
  },
  {
    name: "month",
    args: "month [YYYY-MM]",
    summary: "monthly overview, per-project hours and money",
    flags: ["conceal", "group-by"],
  },
  {
    name: "audit",
    args: "audit [YYYY-MM]",
    summary: "entries needing attention: missing/URL-less note, whole-hour duration",
    flags: ["from", "to", "days"],
  },
  {
    name: "delete",
    args: "delete <entry-id>",
    summary: "delete an entry; --force skips the confirm prompt",
    flags: ["force"],
  },
  { name: "projects", args: "projects", summary: "list active projects (refreshes the cache)", flags: [] },
  { name: "tasks", args: "tasks <project>", summary: "list tasks assigned to a project", flags: [] },
  { name: "alias", args: "alias [list|ls]", summary: "list aliases", flags: [] },
  {
    name: "alias",
    args: "alias <name> <project> [<task>]",
    summary: "set an alias (resolved once, stored by id)",
    flags: [],
  },
  { name: "alias", args: "alias", summary: "remove an alias", flags: ["remove"] },
  { name: "whoami", args: "whoami", summary: "auth check: user, timer mode, cache state", flags: [] },
];

function synopsis(spec: CommandSpec): string {
  const tokens = [spec.args];
  for (const key of spec.flags) {
    const flag = FLAG_BY_KEY.get(key);
    if (flag?.synopsis) tokens.push(flag.synopsis);
  }
  return tokens.filter((t) => t !== "").join(" ");
}

function optionSpec(flag: FlagSpec): ParseArgsOptionsConfig[string] {
  return flag.type === "string"
    ? { type: "string", ...(flag.short ? { short: flag.short } : {}) }
    : { type: "boolean", ...(flag.short ? { short: flag.short } : {}) };
}

const GLOBAL_FLAGS = FLAGS.filter((f) => f.global === true);
const GLOBAL_KEYS = GLOBAL_FLAGS.map((f) => f.key);
const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {};
for (const flag of GLOBAL_FLAGS) GLOBAL_OPTIONS[flag.key] = optionSpec(flag);

/** Options per command, derived from the COMMANDS table so help and parsing cannot drift. */
const COMMAND_OPTIONS: Record<string, ParseArgsOptionsConfig> = {};
for (const command of COMMANDS) {
  const options = COMMAND_OPTIONS[command.name] ?? {};
  COMMAND_OPTIONS[command.name] = options;
  for (const key of command.flags) {
    const flag = FLAG_BY_KEY.get(key);
    if (!flag) throw new Error(`unknown flag "${key}" on ${command.name}`);
    options[key] = optionSpec(flag);
  }
}

const ALL_OPTIONS: ParseArgsOptionsConfig = Object.assign({}, GLOBAL_OPTIONS, ...Object.values(COMMAND_OPTIONS));

const USAGE_COL = 40;
const FLAG_COL = Math.max(...FLAGS.map((f) => f.usage.length)) + 4;

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function renderCommand(spec: CommandSpec): string {
  const head = `  ${synopsis(spec)}`;
  const lines = wrap(spec.summary, 100 - USAGE_COL);
  if (head.length < USAGE_COL) {
    return [`${head.padEnd(USAGE_COL)}${lines[0] ?? ""}`, ...lines.slice(1).map((l) => " ".repeat(USAGE_COL) + l)].join(
      "\n",
    );
  }
  return [head, ...lines.map((l) => " ".repeat(USAGE_COL) + l)].join("\n");
}

function renderFlags(keys: string[]): string {
  return FLAGS.filter((f) => keys.includes(f.key))
    .map((f) => `  ${f.usage.padEnd(FLAG_COL)}${f.help}`)
    .join("\n");
}

const HELP = `harvest — Harvest time tracking from the terminal

usage: harvest [<command>] [args] [flags]

commands:
${COMMANDS.map(renderCommand).join("\n")}

flags:
${renderFlags(GLOBAL_KEYS)}

run harvest <command> --help for that command's usage and flags.

no command = status. Project/task args are fuzzy-matched; a numeric arg
matches by id. Set aliases for the common cases (harvest alias acme
"Acme Website" Development).

setup: create a Personal Access Token (not an OAuth2 app) at
https://id.getharvest.com/developers (Developers section), then store it via
1Password (item "Harvest API" with fields token + account-id), or see the
error message for other options.
`;

function commandHelp(name: string): string | null {
  const specs = COMMANDS.filter((c) => c.name === name);
  if (specs.length === 0) return null;
  const usage =
    specs.length === 1 && specs[0]
      ? `usage: harvest ${synopsis(specs[0])}`
      : ["usage:", ...specs.map((s) => `  harvest ${synopsis(s)}`)].join("\n");
  const summary = specs.flatMap((s) => wrap(s.summary, 80));
  return `${usage}

${summary.join("\n")}

flags:
${renderFlags([...new Set([...specs.flatMap((s) => s.flags), ...GLOBAL_KEYS])])}

run harvest --help for all commands`;
}

interface Cli {
  note?: string;
  date?: string;
  from?: string;
  to?: string;
  days?: string;
  hours?: string;
  project?: string;
  task?: string;
  offset?: string;
  remove: boolean;
  force: boolean;
  groupBy?: "project" | "task" | "note";
  conceal: boolean;
  json: boolean;
  help: boolean;
  positionals: string[];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** node's "place it after --" advice turns a flag into a positional, which fails too. */
function parseOrThrow(args: string[], options: ParseArgsOptionsConfig, cmd: string): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({ args, allowPositionals: true, options });
  } catch (e) {
    const message = (e as Error).message.split(". To specify")[0];
    throw new Error(`${cmd}: ${message} (harvest ${cmd} --help shows its flags)`);
  }
}

/** Strict parse; throws on a flag the command does not take. Exported for tests. */
export function parseCli(argv: string[]): Cli {
  // A non-strict pass only locates the command; the strict one parses its flags.
  let cmd = "status";
  try {
    const probe = parseArgs({ args: argv, allowPositionals: true, options: ALL_OPTIONS, strict: false });
    cmd = probe.positionals[0] ?? "status";
  } catch {
    // Malformed before the command; the strict pass reports the real error.
  }
  const { values, positionals } = parseOrThrow(argv, { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[cmd] ?? {}) }, cmd);
  const note = stringValue(values.note);
  const date = stringValue(values.date);
  const from = stringValue(values.from);
  const to = stringValue(values.to);
  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be yyyy-mm-dd, got "${date}"`);
  }
  if (from !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new Error(`--from must be yyyy-mm-dd, got "${from}"`);
  }
  if (to !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error(`--to must be yyyy-mm-dd, got "${to}"`);
  }
  return {
    note,
    date,
    from,
    to,
    days: stringValue(values.days),
    hours: stringValue(values.hours),
    project: stringValue(values.project),
    task: stringValue(values.task),
    offset: stringValue(values.offset),
    remove: values.remove === true,
    force: values.force === true,
    groupBy: parseGroupBy(stringValue(values["group-by"])),
    conceal: values.conceal === true,
    json: values.json === true,
    help: values.help === true,
    positionals: positionals.filter((p): p is string => typeof p === "string"),
  };
}

/** Help text for a help invocation (`--help`, or `help [command]`), otherwise null. */
export function helpText(cli: Pick<Cli, "help" | "positionals">): string | null {
  if (!cli.help && cli.positionals[0] !== "help") return null;
  const target = cli.positionals[0] === "help" ? cli.positionals[1] : cli.positionals[0];
  if (target === undefined) return HELP.trimEnd();
  return commandHelp(target) ?? HELP.trimEnd();
}

/** Deep-clone with money fields removed — --conceal applies to JSON too. */
export function concealMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(concealMoney);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "amount" || k === "totalAmount" || k === "billable_rate" || k === "cost_rate") continue;
      out[k] = concealMoney(v);
    }
    return out;
  }
  return value;
}

function parseGroupBy(value: string | undefined): "project" | "task" | "note" | undefined {
  if (value === undefined) return undefined;
  if (value === "project" || value === "task" || value === "note") return value;
  throw new Error(`--group-by must be project, task, or note (got "${value}")`);
}

/** True when the alias positionals mean the list form. Exported for tests. */
export function isAliasListForm(p: string[]): boolean {
  return p.length === 0 || (p.length === 1 && (p[0] === "list" || p[0] === "ls"));
}

function arity(cmd: string, positionals: string[], min: number, max: number): string | null {
  if (positionals.length < min) return `${cmd}: missing argument(s)`;
  if (positionals.length > max) return `${cmd}: too many arguments`;
  return null;
}

/** A bad invocation, distinct from a failed command (exit 2, not 1). */
class UsageError extends Error {}

interface Handler {
  min: number;
  max: number;
  run(deps: Deps, positionals: string[], cli: Cli): Promise<CmdResult>;
}

/** One entry per command: dispatch, arity and (via COMMANDS) help. */
const HANDLERS: Record<string, Handler> = {
  status: { min: 0, max: 0, run: async (deps, _p, cli) => cmdStatus(deps, { conceal: cli.conceal }) },
  start: {
    min: 1,
    max: 2,
    run: async (deps, p, cli) => cmdStart(deps, p[0] ?? "", p[1], cli.note, { offset: cli.offset }),
  },
  stop: { min: 0, max: 0, run: async (deps) => cmdStop(deps) },
  resume: { min: 0, max: 1, run: async (deps, p) => cmdResume(deps, p[0]) },
  log: {
    min: 2,
    max: 3,
    run: async (deps, p, cli) => cmdLog(deps, p[0] ?? "", p[1] ?? "", p[2], cli.date, cli.note),
  },
  edit: {
    min: 1,
    max: 1,
    run: async (deps, p, cli) =>
      cmdEdit(deps, p[0] ?? "", {
        hours: cli.hours,
        notes: cli.note,
        date: cli.date,
        project: cli.project,
        task: cli.task,
      }),
  },
  today: {
    min: 0,
    max: 0,
    run: async (deps, _p, cli) => cmdToday(deps, { conceal: cli.conceal, groupBy: cli.groupBy }),
  },
  week: { min: 0, max: 0, run: async (deps, _p, cli) => cmdWeek(deps, { conceal: cli.conceal, groupBy: cli.groupBy }) },
  month: {
    min: 0,
    max: 1,
    run: async (deps, p, cli) => cmdMonth(deps, p[0], { conceal: cli.conceal, groupBy: cli.groupBy }),
  },
  audit: {
    min: 0,
    max: 1,
    run: async (deps, p, cli) => cmdAudit(deps, { month: p[0], from: cli.from, to: cli.to, days: cli.days }),
  },
  delete: {
    min: 1,
    max: 1,
    run: async (deps, p, cli) =>
      cmdDelete(deps, p[0] ?? "", { force: cli.force, confirm: cli.force ? undefined : confirmDelete }),
  },
  projects: { min: 0, max: 0, run: async (deps) => cmdProjects(deps) },
  tasks: { min: 1, max: 1, run: async (deps, p) => cmdTasks(deps, p[0] ?? "") },
  alias: {
    min: 0,
    max: 3,
    run: async (deps, p, cli) => {
      if (cli.remove) {
        const err = arity("alias -r", p, 1, 1);
        if (err) throw new UsageError(err);
        return aliasRemove(deps, p[0] ?? "");
      }
      if (isAliasListForm(p)) return aliasList(deps);
      if (p.length === 2 || p.length === 3) return aliasSet(deps, p[0] ?? "", p[1] ?? "", p[2]);
      throw new UsageError("alias: expected nothing, list/ls, or <name> <project> [<task>]");
    },
  },
  whoami: { min: 0, max: 0, run: async (deps) => cmdWhoami(deps) },
};

/** Command names from the dispatch map. */
export function handledCommands(): string[] {
  return Object.keys(HANDLERS);
}

/** Command names from the help table. */
export function documentedCommands(): string[] {
  return [...new Set(COMMANDS.map((c) => c.name))];
}

/** Handler for a command name; inherited object properties are not commands. */
export function handlerFor(name: string): Handler | undefined {
  return Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
}

async function run(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    console.error(`error: ${(e as Error).message}\n(run harvest --help for usage)`);
    return 2;
  }
  const help = helpText(cli);
  if (help !== null) {
    console.log(help);
    return 0;
  }
  const cmd = cli.positionals[0] ?? "status";
  const p = cli.positionals.slice(1);

  const cfg = loadConfig();
  const cache = loadCache();
  const now = new Date();
  // Auth happens lazily: alias list/remove must work offline.
  let api: ReturnType<typeof createClient> | null = null;
  const deps: Deps = {
    getApi: () => {
      if (!api) api = createClient(resolveAuth(process.env, cfg), cfg.userAgent ?? DEFAULT_USER_AGENT);
      return api;
    },
    cfg,
    cache,
    saveCache: (next) => saveCache(next),
    saveConfig: (next) => saveConfig(next),
    now,
  };

  const handler = handlerFor(cmd);
  if (!handler) return failArg(`unknown command "${cmd}"`);
  const arityErr = arity(cmd, p, handler.min, handler.max);
  if (arityErr) return failArg(arityErr);
  const result = await handler.run(deps, p, cli);

  if (cli.json) {
    const json = cli.conceal ? concealMoney(result.json) : result.json;
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(result.text);
  }
  return 0;
}

function failArg(message: string): number {
  console.error(`error: ${message}\n(run harvest --help for usage)`);
  return 2;
}

/**
 * Interactive delete confirmation. Prompts on stderr when stdin is a TTY;
 * throws on non-TTY so agents get pointed at --force instead of a silent
 * "cancelled".
 */
function confirmDelete(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error("refusing to delete without --force (non-interactive shell)"));
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question("delete this entry? [y/N] ", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

async function main(): Promise<number> {
  try {
    return await run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}\n(run harvest --help for usage)`);
      return 2;
    }
    if (e instanceof HarvestApiError) {
      console.error(`harvest api error ${e.status}: ${e.message}`);
      if (e.status === 401)
        console.error("(token invalid or expired — create a new one at https://id.getharvest.com/developers)");
      if (e.status === 403) console.error("(your Harvest role does not allow this action)");
    } else {
      console.error(`error: ${(e as Error).message}`);
    }
    return 1;
  }
}

// Only run when executed directly — importing this module (tests) must not
// trigger main(), which would probe auth sources.
if (import.meta.main) {
  process.exitCode = await main();
}
