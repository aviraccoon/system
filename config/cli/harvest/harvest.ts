#!/usr/bin/env bun

// harvest — CLI for Harvest time tracking (API v2). Runs under bun.

import { createInterface } from "node:readline";
import {
  arityError,
  type CliSpec,
  type CommandSpec,
  commandNames,
  type FlagSpec,
  type Handler,
  handledNames,
  handlerOf,
  type ParsedCli,
  runCli,
  helpText as sharedHelpText,
  parseCli as sharedParseCli,
  UsageError,
} from "../../shared/cli";
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

const aliasHandler: Handler<Deps, CmdResult, Cli> = {
  min: 0,
  max: 3,
  run: async (deps, p, cli) => {
    if (cli.remove) {
      const err = arityError("alias -r", p.length, 1, 1);
      if (err) throw new UsageError(err);
      return aliasRemove(deps, p[0] ?? "");
    }
    if (isAliasListForm(p)) return aliasList(deps);
    if (p.length === 2 || p.length === 3) return aliasSet(deps, p[0] ?? "", p[1] ?? "", p[2]);
    throw new UsageError("alias: expected nothing, list/ls, or <name> <project> [<task>]");
  },
};

/** One table: help, per-command flags, arity and dispatch. */
const COMMANDS: CommandSpec<Deps, CmdResult, Cli>[] = [
  {
    name: "status",
    args: "status",
    summary: "running timer + today's entries and total",
    flags: ["conceal"],
    handler: { min: 0, max: 0, run: async (deps, _p, cli) => cmdStatus(deps, { conceal: cli.conceal }) },
  },
  {
    name: "start",
    args: "start <project> [<task>]",
    summary: "start a timer (stops the running one)",
    flags: ["note", "offset"],
    handler: {
      min: 1,
      max: 2,
      run: async (deps, p, cli) => cmdStart(deps, p[0] ?? "", p[1], cli.note, { offset: cli.offset }),
    },
  },
  {
    name: "stop",
    args: "stop",
    summary: "stop the running timer",
    handler: { min: 0, max: 0, run: async (deps) => cmdStop(deps) },
  },
  {
    name: "resume",
    args: "resume [<entry-id>]",
    summary:
      "continue a stopped entry after a pause (default: today's stopped entry touched most recently); stops any running timer and keeps its project, task, note and hours",
    handler: { min: 0, max: 1, run: async (deps, p) => cmdResume(deps, p[0]) },
  },
  {
    name: "log",
    args: "log <hours> <project> [<task>]",
    summary: "log past time (1.5, 1:30, 90m)",
    flags: ["note", "date"],
    handler: {
      min: 2,
      max: 3,
      run: async (deps, p, cli) => cmdLog(deps, p[0] ?? "", p[1] ?? "", p[2], cli.date, cli.note),
    },
  },
  {
    name: "edit",
    args: "edit <entry-id>",
    summary: "edit an entry; --project/--task move it",
    flags: ["note", "date", "hours", "project", "task"],
    handler: {
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
  },
  {
    name: "today",
    args: "today",
    summary: "today's entries and total",
    flags: ["conceal", "group-by"],
    handler: {
      min: 0,
      max: 0,
      run: async (deps, _p, cli) => cmdToday(deps, { conceal: cli.conceal, groupBy: cli.groupBy }),
    },
  },
  {
    name: "week",
    args: "week",
    summary: "this ISO week, per-day and per-project totals",
    flags: ["conceal", "group-by"],
    handler: {
      min: 0,
      max: 0,
      run: async (deps, _p, cli) => cmdWeek(deps, { conceal: cli.conceal, groupBy: cli.groupBy }),
    },
  },
  {
    name: "month",
    args: "month [YYYY-MM]",
    summary: "monthly overview, per-project hours and money",
    flags: ["conceal", "group-by"],
    handler: {
      min: 0,
      max: 1,
      run: async (deps, p, cli) => cmdMonth(deps, p[0], { conceal: cli.conceal, groupBy: cli.groupBy }),
    },
  },
  {
    name: "audit",
    args: "audit [YYYY-MM]",
    summary: "entries needing attention: missing/URL-less note, whole-hour duration",
    flags: ["from", "to", "days"],
    handler: {
      min: 0,
      max: 1,
      run: async (deps, p, cli) => cmdAudit(deps, { month: p[0], from: cli.from, to: cli.to, days: cli.days }),
    },
  },
  {
    name: "delete",
    args: "delete <entry-id>",
    summary: "delete an entry; --force skips the confirm prompt",
    flags: ["force"],
    handler: {
      min: 1,
      max: 1,
      run: async (deps, p, cli) =>
        cmdDelete(deps, p[0] ?? "", { force: cli.force, confirm: cli.force ? undefined : confirmDelete }),
    },
  },
  {
    name: "projects",
    args: "projects",
    summary: "list active projects (refreshes the cache)",
    handler: { min: 0, max: 0, run: async (deps) => cmdProjects(deps) },
  },
  {
    name: "tasks",
    args: "tasks <project>",
    summary: "list tasks assigned to a project",
    handler: { min: 1, max: 1, run: async (deps, p) => cmdTasks(deps, p[0] ?? "") },
  },
  { name: "alias", args: "alias [list|ls]", summary: "list aliases", handler: aliasHandler },
  {
    name: "alias",
    args: "alias <name> <project> [<task>]",
    summary: "set an alias (resolved once, stored by id)",
    handler: aliasHandler,
  },
  { name: "alias", args: "alias", summary: "remove an alias", flags: ["remove"], handler: aliasHandler },
  {
    name: "whoami",
    args: "whoami",
    summary: "auth check: user, timer mode, cache state",
    handler: { min: 0, max: 0, run: async (deps) => cmdWhoami(deps) },
  },
];

const SPEC: CliSpec<Deps, CmdResult, Cli> = {
  name: "harvest",
  summary: "Harvest time tracking from the terminal",
  usage: "harvest [<command>] [args] [flags]",
  intro: `no command = status. Project/task args are fuzzy-matched; a numeric arg
matches by id. Set aliases for the common cases (harvest alias acme
"Acme Website" Development).

setup: create a Personal Access Token (not an OAuth2 app) at
https://id.getharvest.com/developers (Developers section), then store it via
1Password (item "Harvest API" with fields token + account-id), or see the
error message for other options.`,
  flags: FLAGS,
  commands: COMMANDS,
  default: "status",
};

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

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The typed view handlers consume, built from the shared parser's values. */
function toCli(parsed: ParsedCli): Cli {
  const values = parsed.values;
  const date = stringValue(values.date);
  const from = stringValue(values.from);
  const to = stringValue(values.to);
  if (date !== undefined && !DATE.test(date)) throw new UsageError(`--date must be yyyy-mm-dd, got "${date}"`);
  if (from !== undefined && !DATE.test(from)) throw new UsageError(`--from must be yyyy-mm-dd, got "${from}"`);
  if (to !== undefined && !DATE.test(to)) throw new UsageError(`--to must be yyyy-mm-dd, got "${to}"`);
  return {
    note: stringValue(values.note),
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
    positionals: parsed.positionals,
  };
}

/** Strict parse; throws on a flag the command does not take. Exported for tests. */
export function parseCli(argv: string[]): Cli {
  return toCli(sharedParseCli(SPEC, argv));
}

/** Help text for a help invocation (`--help`, or `help [command]`), otherwise null. */
export function helpText(cli: Pick<Cli, "help" | "positionals">): string | null {
  return sharedHelpText(SPEC, cli);
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
  throw new UsageError(`--group-by must be project, task, or note (got "${value}")`);
}

/** True when the alias positionals mean the list form. Exported for tests. */
export function isAliasListForm(p: string[]): boolean {
  return p.length === 0 || (p.length === 1 && (p[0] === "list" || p[0] === "ls"));
}

/** Command names from the dispatch table. */
export function handledCommands(): string[] {
  return handledNames(SPEC);
}

/** Command names from the help table. */
export function documentedCommands(): string[] {
  return commandNames(SPEC);
}

/** Handler for a command name; inherited object properties are not commands. */
export function handlerFor(name: string): Handler<Deps, CmdResult, Cli> | undefined {
  return handlerOf(SPEC, name);
}

/** Runtime deps for one invocation. Auth stays lazy: alias list/remove work offline. */
function makeDeps(): Deps {
  const cfg = loadConfig();
  const cache = loadCache();
  const now = new Date();
  let api: ReturnType<typeof createClient> | null = null;
  return {
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
}

async function run(argv: string[]): Promise<number> {
  return runCli<Deps, CmdResult, Cli>({
    spec: SPEC,
    argv,
    adapt: toCli,
    context: () => makeDeps(),
    print: (result, cli) => {
      if (cli.json) {
        const json = cli.conceal ? concealMoney(result.json) : result.json;
        console.log(JSON.stringify(json, null, 2));
      } else {
        console.log(result.text);
      }
    },
    mapError: (error) => {
      if (!(error instanceof HarvestApiError)) return undefined;
      const lines = [`harvest api error ${error.status}: ${error.message}`];
      if (error.status === 401) {
        lines.push("(token invalid or expired — create a new one at https://id.getharvest.com/developers)");
      }
      if (error.status === 403) lines.push("(your Harvest role does not allow this action)");
      return { code: 1, lines };
    },
  });
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
    // runCli owns usage and API failures; this is the last-resort net.
    console.error(`error: ${(e as Error).message}`);
    return 1;
  }
}

// Only run when executed directly — importing this module (tests) must not
// trigger main(), which would probe auth sources.
if (import.meta.main) {
  process.exitCode = await main();
}
