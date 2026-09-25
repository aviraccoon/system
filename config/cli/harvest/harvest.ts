#!/usr/bin/env bun

// harvest — CLI for Harvest time tracking (API v2). Runs under bun.

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
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

const HELP = `harvest — Harvest time tracking from the terminal

usage: harvest [<command>] [args] [flags]

commands:
  status                      running timer + today's entries and total
  start <project> [<task>]    start a timer (stops the running one; --offset 25m credits prior time)
  stop                        stop the running timer
  log <hours> <project> [<task>] [--date D]   log past time (1.5, 1:30, 90m)
  edit <entry-id> [--hours H] [-n text] [--date D] [--project P] [--task T]
                              edit an entry; --project/--task move it
  today                       today's entries and total
  week                        this ISO week, per-day and per-project totals
  month [YYYY-MM]             monthly overview, per-project hours and money
  audit [YYYY-MM]             entries needing attention: missing/URL-less note, whole-hour duration
                              ranges: --days 7, or --from D --to D
  projects                    list active projects (refreshes the cache)
  tasks <project>             list tasks assigned to a project
  alias [list|ls]             list aliases
  alias <name> <project> [<task>]   set an alias (resolved once, stored by id)
  alias -r <name>             remove an alias
  whoami                      auth check: user, timer mode, cache state

flags:
  -n, --note <text>           note for start/log
  --date <yyyy-mm-dd>         date for log
  --from <yyyy-mm-dd>         audit range start (with --to)
  --to <yyyy-mm-dd>           audit range end (with --from)
  --days <n>                  audit: last n days including today
  --hours <hours>             hours for edit
  --project <query>           with edit: project to move the entry to
  --task <query>              with edit: task on the target (or current) project
  --offset <duration>         with start: time already spent (25m, 1:30, 1h30m)
  -f, --force                 with delete: skip the confirm prompt
  --group-by <dim>            group today/week/month by project|task|note
  -r, --remove                with alias
  --json                      machine-readable output
  --conceal                   hide money amounts (status/today/week/month)
  -h, --help                  this help

no command = status. Project/task args are fuzzy-matched; a numeric arg
matches by id. Set aliases for the common cases (harvest alias acme
"Acme Website" Development).

setup: create a Personal Access Token (not an OAuth2 app) at
https://id.getharvest.com/developers (Developers section), then store it via
1Password (item "Harvest API" with fields token + account-id), or see the
error message for other options.
`;

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

/** Strict parse; throws on unknown flags. Exported for tests. */
export function parseCli(argv: string[]): Cli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      note: { type: "string", short: "n" },
      date: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      days: { type: "string" },
      hours: { type: "string" },
      project: { type: "string" },
      task: { type: "string" },
      offset: { type: "string" },
      remove: { type: "boolean", short: "r" },
      force: { type: "boolean", short: "f" },
      "group-by": { type: "string" },
      conceal: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const note = values.note;
  const date = values.date;
  const from = values.from;
  const to = values.to;
  if (typeof note !== "string" && note !== undefined) throw new Error("--note takes a string");
  if (typeof date !== "string" && date !== undefined) throw new Error("--date takes a string");
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
    days: values.days,
    hours: values.hours,
    project: values.project,
    task: values.task,
    offset: values.offset,
    remove: values.remove === true,
    force: values.force === true,
    groupBy: parseGroupBy(values["group-by"]),
    conceal: values.conceal === true,
    json: values.json === true,
    help: values.help === true,
    positionals: positionals.filter((p): p is string => typeof p === "string"),
  };
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

async function run(argv: string[]): Promise<number> {
  let cli: Cli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    console.error(`error: ${(e as Error).message}\n(run harvest --help for usage)`);
    return 2;
  }
  if (cli.help || (cli.positionals[0] ?? null) === "help") {
    console.log(HELP.trimEnd());
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

  let result: CmdResult;
  switch (cmd) {
    case "status": {
      const err = arity("status", p, 0, 0);
      if (err) return failArg(err);
      result = await cmdStatus(deps, { conceal: cli.conceal });
      break;
    }
    case "start": {
      const err = arity("start", p, 1, 2);
      if (err) return failArg(err);
      result = await cmdStart(deps, p[0] ?? "", p[1], cli.note, { offset: cli.offset });
      break;
    }
    case "stop": {
      const err = arity("stop", p, 0, 0);
      if (err) return failArg(err);
      result = await cmdStop(deps);
      break;
    }
    case "log": {
      const err = arity("log", p, 2, 3);
      if (err) return failArg(err);
      result = await cmdLog(deps, p[0] ?? "", p[1] ?? "", p[2], cli.date, cli.note);
      break;
    }
    case "edit": {
      const err = arity("edit", p, 1, 1);
      if (err) return failArg(err);
      result = await cmdEdit(deps, p[0] ?? "", {
        hours: cli.hours,
        notes: cli.note,
        date: cli.date,
        project: cli.project,
        task: cli.task,
      });
      break;
    }
    case "today": {
      const err = arity("today", p, 0, 0);
      if (err) return failArg(err);
      result = await cmdToday(deps, { conceal: cli.conceal, groupBy: cli.groupBy });
      break;
    }
    case "week": {
      const err = arity("week", p, 0, 0);
      if (err) return failArg(err);
      result = await cmdWeek(deps, { conceal: cli.conceal, groupBy: cli.groupBy });
      break;
    }
    case "month": {
      const err = arity("month", p, 0, 1);
      if (err) return failArg(err);
      result = await cmdMonth(deps, p[0], { conceal: cli.conceal, groupBy: cli.groupBy });
      break;
    }
    case "audit": {
      const err = arity("audit", p, 0, 1);
      if (err) return failArg(err);
      result = await cmdAudit(deps, { month: p[0], from: cli.from, to: cli.to, days: cli.days });
      break;
    }
    case "delete": {
      const err = arity("delete", p, 1, 1);
      if (err) return failArg(err);
      result = await cmdDelete(deps, p[0] ?? "", {
        force: cli.force,
        confirm: cli.force ? undefined : confirmDelete,
      });
      break;
    }
    case "projects": {
      const err = arity("projects", p, 0, 0);
      if (err) return failArg(err);
      result = await cmdProjects(deps);
      break;
    }
    case "tasks": {
      const err = arity("tasks", p, 1, 1);
      if (err) return failArg(err);
      result = await cmdTasks(deps, p[0] ?? "");
      break;
    }
    case "alias": {
      if (cli.remove) {
        const err = arity("alias -r", p, 1, 1);
        if (err) return failArg(err);
        result = aliasRemove(deps, p[0] ?? "");
      } else if (isAliasListForm(p)) {
        result = aliasList(deps);
      } else if (p.length === 2 || p.length === 3) {
        result = await aliasSet(deps, p[0] ?? "", p[1] ?? "", p[2]);
      } else {
        return failArg("alias: expected nothing, list/ls, or <name> <project> [<task>]");
      }
      break;
    }
    case "whoami": {
      const err = arity("whoami", p, 0, 0);
      if (err) return failArg(err);
      result = await cmdWhoami(deps);
      break;
    }
    default:
      console.error(`error: unknown command "${cmd}"\n(run harvest --help for usage)`);
      return 2;
  }

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
