// Command implementations. All I/O goes through Deps so tests inject stubs.

import type { HarvestClient, TimeEntry } from "./api";
import type { Alias, HarvestCache, HarvestConfig } from "./config";
import { isFresh } from "./config";
import {
  buildCreateEntryBody,
  clockTime,
  entryElapsed,
  formatHours,
  formatMoney,
  localDateString,
  parseHours,
  weekDates,
} from "./format";
import { type Candidate, formatCandidates, matchOne } from "./resolve";

const DAY = 24 * 3600_000;
const WEEK = 7 * DAY;

export interface Deps {
  getApi(): HarvestClient;
  cfg: HarvestConfig;
  cache: HarvestCache;
  saveCache(next: HarvestCache): void;
  saveConfig(next: HarvestConfig): void;
  now: Date;
}

export interface CmdResult {
  text: string;
  json: unknown;
}

function remember(deps: Deps, key: string): void {
  deps.cache.fetchedAt = { ...deps.cache.fetchedAt, [key]: deps.now.getTime() };
}

async function ensureMe(deps: Deps) {
  if (deps.cache.me) return deps.cache.me;
  const me = await deps.getApi().me();
  deps.cache.me = me;
  remember(deps, "me");
  deps.saveCache(deps.cache);
  return me;
}

async function ensureTimerMode(deps: Deps): Promise<boolean> {
  if (deps.cache.timestampTimers !== undefined && isFresh(deps.cache, "company", WEEK, deps.now.getTime())) {
    return deps.cache.timestampTimers;
  }
  const company = await deps.getApi().company();
  deps.cache.timestampTimers = company.wants_timestamp_timers;
  deps.cache.currencyCode = company.currency ? company.currency.toUpperCase() : null;
  remember(deps, "company");
  deps.saveCache(deps.cache);
  return company.wants_timestamp_timers;
}

async function ensureCurrency(deps: Deps): Promise<string | null> {
  await ensureTimerMode(deps);
  return deps.cache.currencyCode ?? null;
}

async function ensureProjects(deps: Deps, force = false): Promise<NonNullable<HarvestCache["projects"]>> {
  if (force || !deps.cache.projects || !isFresh(deps.cache, "projects", DAY, deps.now.getTime())) {
    // Members can't list account projects; their own project assignments carry
    // everything a personal CLI needs (projects + tasks per project).
    const assignments = await deps.getApi().projectAssignments();
    deps.cache.projects = assignments
      .filter((a) => a.is_active)
      .map((a) => ({ id: a.project.id, name: a.project.name, code: a.project.code, client: a.client?.name ?? null }));
    const tasksByProject: Record<string, { id: number; name: string }[]> = {};
    for (const a of assignments) {
      tasksByProject[String(a.project.id)] = a.task_assignments
        .filter((t) => t.is_active)
        .map((t) => ({ id: t.task.id, name: t.task.name }));
    }
    deps.cache.tasksByProject = tasksByProject;
    remember(deps, "projects");
    deps.saveCache(deps.cache);
  }
  return deps.cache.projects ?? [];
}

async function ensureTasks(deps: Deps, projectId: number): Promise<{ id: number; name: string }[]> {
  await ensureProjects(deps);
  return deps.cache.tasksByProject?.[String(projectId)] ?? [];
}

function fail(message: string): never {
  throw new Error(message);
}

interface Target {
  projectId: number;
  projectName: string;
  taskId: number;
  taskName: string;
}

/** Resolve a user-typed name like "acme" or "Acme Website" to project + task ids. Alias names win. */
async function resolveProjectAndTask(deps: Deps, projectQuery: string, taskQuery?: string): Promise<Target> {
  const alias = deps.cfg.aliases[projectQuery.trim().toLowerCase()];
  let projectId: number;
  let projectName: string;
  const effectiveTaskQuery = taskQuery;

  if (alias) {
    projectId = alias.projectId;
    projectName = alias.projectName;
    if (!effectiveTaskQuery && alias.taskId) {
      return { projectId, projectName, taskId: alias.taskId, taskName: alias.taskName ?? "" };
    }
  } else {
    const projects = await ensureProjects(deps);
    let hit = matchOne(projectQuery, projects);
    if (hit.kind === "none") hit = matchOne(projectQuery, await ensureProjects(deps, true));
    if (hit.kind === "none") {
      fail(`no project matching "${projectQuery}". Known projects:\n${formatCandidates(await ensureProjects(deps))}`);
    }
    if (hit.kind === "ambiguous") {
      fail(`ambiguous project "${projectQuery}":\n${formatCandidates(hit.candidates)}`);
    }
    projectId = hit.item.id;
    projectName = hit.item.name;
  }

  const tasks = await ensureTasks(deps, projectId);
  if (effectiveTaskQuery) {
    const hit = matchOne(effectiveTaskQuery, tasks);
    if (hit.kind === "none")
      fail(`no task matching "${effectiveTaskQuery}" on ${projectName}. Tasks:\n${formatCandidates(tasks)}`);
    if (hit.kind === "ambiguous")
      fail(`ambiguous task "${effectiveTaskQuery}" on ${projectName}:\n${formatCandidates(hit.candidates)}`);
    return { projectId, projectName, taskId: hit.item.id, taskName: hit.item.name };
  }
  if (tasks.length === 1 && tasks[0]) {
    return { projectId, projectName, taskId: tasks[0].id, taskName: tasks[0].name };
  }
  fail(`no task given for ${projectName} and ${tasks.length} tasks are assigned. Tasks:\n${formatCandidates(tasks)}`);
}

async function runningEntries(deps: Deps): Promise<TimeEntry[]> {
  const me = await ensureMe(deps);
  return deps.getApi().timeEntries({ user_id: me.id, is_running: true });
}

async function todayEntries(deps: Deps): Promise<TimeEntry[]> {
  const me = await ensureMe(deps);
  const today = localDateString(deps.now);
  return deps.getApi().timeEntries({ user_id: me.id, from: today, to: today });
}

function entryLabel(e: TimeEntry): string {
  const client = e.client?.name ? `${e.client.name} / ` : "";
  return `${client}${e.project.name} / ${e.task.name}`;
}

function totalHours(entries: TimeEntry[]): number {
  return entries.reduce((sum, e) => sum + e.hours, 0);
}

interface MoneySum {
  hours: number;
  ratedHours: number;
  amount: number;
}

/** Rate for an entry: config wins, entry rate fallback. Null = no rate known. */
function entryRate(cfg: HarvestConfig, e: TimeEntry): number | null {
  if (cfg.hourlyRate !== undefined) return cfg.hourlyRate;
  return e.billable_rate;
}

function sumMoney(entries: TimeEntry[], cfg: HarvestConfig): MoneySum {
  const sum: MoneySum = { hours: 0, ratedHours: 0, amount: 0 };
  for (const e of entries) {
    sum.hours += e.hours;
    const rate = entryRate(cfg, e);
    if (rate !== null) {
      sum.amount += e.hours * rate;
      sum.ratedHours += e.hours;
    }
  }
  return sum;
}

/** " — 12 345.00 CZK" suffix, or "" when concealed / unrated / currency unknown. */
function moneySuffix(
  sum: MoneySum,
  currency: string | null,
  cfg: HarvestConfig,
  conceal: boolean,
  withRate = false,
): string {
  if (conceal || currency === null || sum.ratedHours <= 0) return "";
  const rateNote = withRate && cfg.hourlyRate !== undefined ? ` (rate ${cfg.hourlyRate})` : "";
  return ` — ${formatMoney(sum.amount, currency)}${rateNote}`;
}

async function stopRunning(deps: Deps): Promise<TimeEntry[]> {
  const running = await runningEntries(deps);
  const stopped: TimeEntry[] = [];
  for (const entry of running) {
    stopped.push(await deps.getApi().stopEntry(entry.id));
  }
  return stopped;
}

export async function cmdStatus(deps: Deps, opts: { conceal?: boolean } = {}): Promise<CmdResult> {
  const conceal = opts.conceal === true;
  const running = await runningEntries(deps);
  const today = await todayEntries(deps);
  const currency = await ensureCurrency(deps);
  const lines: string[] = [];
  let runningJson: Record<string, unknown> | null = null;
  if (running.length > 0) {
    const entry = running[0];
    if (!entry) fail("running entry vanished");
    const elapsed = entryElapsed(entry, deps.now.getTime()) ?? "?";
    const since = entry.timer_started_at
      ? `since ${clockTime(new Date(entry.timer_started_at))}`
      : entry.started_time
        ? `since ${entry.started_time}`
        : "";
    const stale =
      entry.spent_date !== localDateString(deps.now) ? ` — STALE (started ${entry.spent_date}, run harvest stop)` : "";
    lines.push(`▶ ${entryLabel(entry)} ${elapsed} ${since}${stale}`.trimEnd());
    if (entry.notes) lines.push(`  ${entry.notes}`);
    runningJson = { ...entry, elapsed };
  } else {
    lines.push("no timer running");
  }
  const todaySum = sumMoney(today, deps.cfg);
  lines.push(
    `today: ${formatHours(todaySum.hours)} (${today.length} ${today.length === 1 ? "entry" : "entries"})${moneySuffix(todaySum, currency, deps.cfg, conceal)}`,
  );
  for (const e of [...today].sort((a, b) => a.id - b.id)) {
    const money = moneySuffix(sumMoney([e], deps.cfg), currency, deps.cfg, conceal);
    lines.push(
      `  ${formatHours(e.hours)}${e.is_running ? " ▶" : ""}  ${entryLabel(e)}${money}${e.notes ? ` — ${e.notes}` : ""}`,
    );
  }
  return {
    text: lines.join("\n"),
    json: { running: runningJson, today, total: totalHours(today), totalAmount: todaySum.amount },
  };
}

export async function cmdStart(
  deps: Deps,
  projectQuery: string,
  taskQuery?: string,
  notes?: string,
): Promise<CmdResult> {
  const target = await resolveProjectAndTask(deps, projectQuery, taskQuery);
  const stopped = await stopRunning(deps);
  const timestampTimers = await ensureTimerMode(deps);
  const entry = await deps.getApi().createTimeEntry(
    buildCreateEntryBody({
      timestampTimers,
      projectId: target.projectId,
      taskId: target.taskId,
      spentDate: localDateString(deps.now),
      notes,
      now: deps.now,
    }),
  );
  const lines: string[] = [];
  for (const s of stopped) lines.push(`■ stopped ${entryLabel(s)} at ${formatHours(s.hours)}`);
  lines.push(`▶ ${entryLabel(entry)} — started ${clockTime(deps.now)}${notes ? ` — ${notes}` : ""}`);
  return { text: lines.join("\n"), json: { entry, stopped } };
}

export async function cmdStop(deps: Deps): Promise<CmdResult> {
  const running = await runningEntries(deps);
  if (running.length === 0) fail("no running timer");
  const stopped: TimeEntry[] = [];
  for (const entry of running) {
    stopped.push(await deps.getApi().stopEntry(entry.id));
  }
  return {
    text: stopped.map((s) => `■ ${entryLabel(s)} — stopped at ${formatHours(s.hours)}`).join("\n"),
    json: { stopped },
  };
}

export async function cmdLog(
  deps: Deps,
  hoursInput: string,
  projectQuery: string,
  taskQuery?: string,
  date?: string,
  notes?: string,
): Promise<CmdResult> {
  const hours = parseHours(hoursInput);
  if (hours === null || hours <= 0) fail(`bad hours "${hoursInput}" (use e.g. 1.5, 1:30, 90m)`);
  const target = await resolveProjectAndTask(deps, projectQuery, taskQuery);
  const timestampTimers = await ensureTimerMode(deps);
  const entry = await deps.getApi().createTimeEntry(
    buildCreateEntryBody({
      timestampTimers,
      projectId: target.projectId,
      taskId: target.taskId,
      spentDate: date ?? localDateString(deps.now),
      notes,
      hours,
      now: deps.now,
    }),
  );
  return {
    text: `logged ${formatHours(hours)} → ${entryLabel(entry)} (${entry.spent_date})${notes ? ` — ${notes}` : ""}`,
    json: { entry },
  };
}

export async function cmdEdit(
  deps: Deps,
  entryId: string,
  opts: { hours?: string; notes?: string; date?: string },
): Promise<CmdResult> {
  const id = Number(entryId);
  if (!Number.isInteger(id) || id <= 0) fail(`bad entry id "${entryId}"`);
  const body: Record<string, unknown> = {};
  if (opts.hours !== undefined) {
    const h = parseHours(opts.hours);
    if (h === null || h <= 0) fail(`bad hours "${opts.hours}" (use e.g. 1.5, 1:30, 90m)`);
    body.hours = h;
  }
  if (opts.notes !== undefined) body.notes = opts.notes;
  if (opts.date !== undefined) body.spent_date = opts.date;
  if (Object.keys(body).length === 0) fail("nothing to edit (use --hours, --note, or --date)");
  const entry = await deps.getApi().request<TimeEntry>("PATCH", `/time_entries/${id}`, body);
  return {
    text: `edited ${entryLabel(entry)} (${entry.spent_date}) → ${formatHours(entry.hours)}${entry.notes ? ` — ${entry.notes}` : ""}`,
    json: { entry },
  };
}

export async function cmdToday(deps: Deps, opts: { conceal?: boolean } = {}): Promise<CmdResult> {
  const conceal = opts.conceal === true;
  const today = await todayEntries(deps);
  const currency = await ensureCurrency(deps);
  const todaySum = sumMoney(today, deps.cfg);
  const lines = [
    `today: ${formatHours(todaySum.hours)} (${today.length} ${today.length === 1 ? "entry" : "entries"})${moneySuffix(todaySum, currency, deps.cfg, conceal)}`,
  ];
  for (const e of [...today].sort((a, b) => a.id - b.id)) {
    const money = moneySuffix(sumMoney([e], deps.cfg), currency, deps.cfg, conceal);
    lines.push(
      `  ${formatHours(e.hours)}${e.is_running ? " ▶" : ""}  ${entryLabel(e)}${money}${e.notes ? ` — ${e.notes}` : ""}`,
    );
  }
  return { text: lines.join("\n"), json: { entries: today, total: totalHours(today), totalAmount: todaySum.amount } };
}

export function monthRange(monthArg: string | undefined, now: Date): { label: string; from: string; to: string } {
  const label = monthArg ?? localDateString(now).slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) fail(`month must be YYYY-MM, got "${monthArg ?? label}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) fail(`month must be YYYY-MM, got "${label}"`);
  const to = new Date(y, mo, 0); // day 0 of month index mo = last day of month mo
  return { label, from: `${label}-01`, to: localDateString(to) };
}

export async function cmdMonth(deps: Deps, monthArg?: string, opts: { conceal?: boolean } = {}): Promise<CmdResult> {
  const conceal = opts.conceal === true;
  const { label, from, to } = monthRange(monthArg, deps.now);
  const me = await ensureMe(deps);
  const entries = await deps.getApi().timeEntries({ user_id: me.id, from, to });
  const currency = await ensureCurrency(deps);

  // Exact tracked hours (raw `hours`, the rounding-agnostic ground truth).
  // Rate: config wins, entry rate fallback; the billable flag is
  // ignored — in practice the user's work is billable regardless of project flags.
  const byProject = new Map<string, { hours: number; ratedHours: number; amount: number }>();
  for (const e of entries) {
    const g = byProject.get(e.project.name) ?? { hours: 0, ratedHours: 0, amount: 0 };
    g.hours += e.hours;
    const rate = deps.cfg.hourlyRate ?? e.billable_rate;
    if (rate !== null && rate !== undefined) {
      g.amount += e.hours * rate;
      g.ratedHours += e.hours;
    }
    byProject.set(e.project.name, g);
  }
  const groups = [...byProject.entries()].sort((a, b) => b[1].hours - a[1].hours);
  const totalHours = groups.reduce((s, [, g]) => s + g.hours, 0);
  const totalAmount = groups.reduce((s, [, g]) => s + g.amount, 0);
  const ratedHours = groups.reduce((s, [, g]) => s + g.ratedHours, 0);

  const money = (amount: number): string => (currency ? formatMoney(amount, currency) : amount.toFixed(2));
  const rateNote = deps.cfg.hourlyRate !== undefined ? ` (rate ${deps.cfg.hourlyRate})` : "";
  const headerMoney = !conceal && ratedHours > 0 ? ` — ${money(totalAmount)}${rateNote}` : "";
  const lines = [`${label}: ${formatHours(totalHours)} total${headerMoney}`];
  for (const [name, g] of groups) {
    const amount = !conceal && g.ratedHours > 0 && currency ? ` — ${money(g.amount)}` : "";
    lines.push(`  ${formatHours(g.hours)}  ${name}${amount}`);
  }
  const unrated = totalHours - ratedHours;
  if (unrated > 0.0001) {
    lines.push(`  ${formatHours(unrated)} without a rate — set "hourlyRate" in ~/.config/harvest/config.json`);
  }
  return {
    text: lines.join("\n"),
    json: {
      month: label,
      from,
      to,
      entries,
      groups: groups.map(([name, g]) => ({
        project: name,
        hours: g.hours,
        amount: g.amount,
        ratedHours: g.ratedHours,
      })),
      totalHours,
      totalAmount,
    },
  };
}

export async function cmdWeek(deps: Deps, opts: { conceal?: boolean } = {}): Promise<CmdResult> {
  const conceal = opts.conceal === true;
  const me = await ensureMe(deps);
  const days = weekDates(deps.now);
  const entries = await deps.getApi().timeEntries({ user_id: me.id, from: days[0], to: days[days.length - 1] });
  const currency = await ensureCurrency(deps);
  const byDate = new Map<string, TimeEntry[]>();
  const byProject = new Map<string, number>();
  for (const e of entries) {
    const list = byDate.get(e.spent_date) ?? [];
    list.push(e);
    byDate.set(e.spent_date, list);
    byProject.set(e.project.name, (byProject.get(e.project.name) ?? 0) + e.hours);
  }
  const lines: string[] = [];
  for (const day of days) {
    const list = byDate.get(day);
    if (!list) continue;
    lines.push(
      `${day}: ${formatHours(totalHours(list))}${moneySuffix(sumMoney(list, deps.cfg), currency, deps.cfg, conceal)}`,
    );
    for (const e of [...list].sort((a, b) => a.id - b.id)) {
      const money = moneySuffix(sumMoney([e], deps.cfg), currency, deps.cfg, conceal);
      lines.push(
        `  ${formatHours(e.hours)}${e.is_running ? " ▶" : ""}  ${entryLabel(e)}${money}${e.notes ? ` — ${e.notes}` : ""}`,
      );
    }
  }
  lines.push(
    `week: ${formatHours(totalHours(entries))}${moneySuffix(sumMoney(entries, deps.cfg), currency, deps.cfg, conceal)}`,
  );
  for (const [project, hours] of [...byProject.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${formatHours(hours)}  ${project}`);
  }
  return { text: lines.join("\n"), json: { entries, total: totalHours(entries) } };
}

export async function cmdProjects(deps: Deps): Promise<CmdResult> {
  const projects = await ensureProjects(deps, true);
  const lines = projects.map(
    (p) => `${p.id}  ${p.client ? `${p.client} / ` : ""}${p.name}${p.code ? ` (${p.code})` : ""}`,
  );
  return { text: lines.join("\n"), json: { projects } };
}

export async function cmdTasks(deps: Deps, projectQuery: string): Promise<CmdResult> {
  const projects = await ensureProjects(deps);
  let hit = matchOne(projectQuery, projects);
  if (hit.kind === "none") hit = matchOne(projectQuery, await ensureProjects(deps, true));
  if (hit.kind === "none")
    fail(`no project matching "${projectQuery}". Known projects:\n${formatCandidates(await ensureProjects(deps))}`);
  if (hit.kind === "ambiguous") fail(`ambiguous project "${projectQuery}":\n${formatCandidates(hit.candidates)}`);
  const tasks = await ensureTasks(deps, hit.item.id);
  return {
    text: tasks.map((t) => `${t.id}  ${t.name}`).join("\n"),
    json: { project: hit.item, tasks },
  };
}

export function aliasList(deps: Deps): CmdResult {
  const names = Object.keys(deps.cfg.aliases).sort();
  if (names.length === 0)
    return { text: "no aliases (set with: harvest alias <name> <project> [<task>])", json: { aliases: {} } };
  const lines = names.map((n) => {
    const a = deps.cfg.aliases[n];
    if (!a) return `  ${n}`;
    return `  ${n} → ${a.projectName}${a.taskName ? ` / ${a.taskName}` : ""}`;
  });
  return { text: lines.join("\n"), json: { aliases: deps.cfg.aliases } };
}

export async function aliasSet(deps: Deps, name: string, projectQuery: string, taskQuery?: string): Promise<CmdResult> {
  // Taskless aliases are allowed: start/log then require the task each time.
  const projects = await ensureProjects(deps);
  let hit = matchOne(projectQuery, projects);
  if (hit.kind === "none") hit = matchOne(projectQuery, await ensureProjects(deps, true));
  if (hit.kind === "none")
    fail(`no project matching "${projectQuery}". Known projects:\n${formatCandidates(await ensureProjects(deps))}`);
  if (hit.kind === "ambiguous") fail(`ambiguous project "${projectQuery}":\n${formatCandidates(hit.candidates)}`);
  let taskId: number | null = null;
  let taskName: string | null = null;
  if (taskQuery) {
    const tasks = await ensureTasks(deps, hit.item.id);
    const taskHit = matchOne(taskQuery, tasks);
    if (taskHit.kind === "none")
      fail(`no task matching "${taskQuery}" on ${hit.item.name}. Tasks:\n${formatCandidates(tasks)}`);
    if (taskHit.kind === "ambiguous")
      fail(`ambiguous task "${taskQuery}" on ${hit.item.name}:\n${formatCandidates(taskHit.candidates)}`);
    taskId = taskHit.item.id;
    taskName = taskHit.item.name;
  }
  const alias: Alias = {
    projectId: hit.item.id,
    projectName: hit.item.name,
    taskId,
    taskName,
  };
  deps.cfg.aliases = { ...deps.cfg.aliases, [name.toLowerCase()]: alias };
  deps.saveConfig(deps.cfg);
  return {
    text: `alias ${name.toLowerCase()} → ${hit.item.name}${taskName ? ` / ${taskName}` : ""}`,
    json: { alias },
  };
}

export function aliasRemove(deps: Deps, name: string): CmdResult {
  const key = name.toLowerCase();
  if (!deps.cfg.aliases[key]) fail(`no alias "${key}"`);
  const aliases = { ...deps.cfg.aliases };
  delete aliases[key];
  deps.cfg.aliases = aliases;
  deps.saveConfig(deps.cfg);
  return { text: `removed alias ${key}`, json: { aliases } };
}

export async function cmdWhoami(deps: Deps): Promise<CmdResult> {
  const me = await ensureMe(deps);
  const timestampTimers = await ensureTimerMode(deps);
  const text = [
    `${[me.first_name, me.last_name].filter(Boolean).join(" ")} <${me.email}> (user id ${me.id})`,
    `timer mode: ${timestampTimers ? "start/end times" : "duration"}`,
    `cached projects: ${deps.cache.projects?.length ?? 0}`,
  ].join("\n");
  return { text, json: { user: me, timestampTimers } };
}

export type { Candidate };
