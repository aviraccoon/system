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
  withNotes,
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

/** True when the note contains an http(s) URL. */
export function noteHasLink(note: string | null | undefined): boolean {
  return note !== null && note !== undefined && /https?:\/\//.test(note);
}

/**
 * Warning lines appended after create/update when the resulting note has no
 * link and requireNoteLinks is on. The entry exists either way — the warning
 * points at the fix instead of blocking.
 */
function noteLinkWarnings(cfg: HarvestConfig, entry: TimeEntry): string[] {
  if (cfg.requireNoteLinks !== true || noteHasLink(entry.notes)) return [];
  return [
    `⚠ note has no link (requireNoteLinks) — fix with: harvest edit ${entry.id} -n "<note with the work-thread link>"`,
  ];
}

interface Target {
  projectId: number;
  projectName: string;
  taskId: number;
  taskName: string;
}

/**
 * Alias-first project lookup, shared by every command that takes a project
 * query: the alias name wins, otherwise a fuzzy match (fresh-cache retry on
 * a miss).
 */
async function resolveProjectRef(
  deps: Deps,
  projectQuery: string,
): Promise<{ id: number; name: string; viaAlias: Alias | null }> {
  const alias = deps.cfg.aliases[projectQuery.trim().toLowerCase()];
  if (alias) return { id: alias.projectId, name: alias.projectName, viaAlias: alias };
  const projects = await ensureProjects(deps);
  let hit = matchOne(projectQuery, projects);
  if (hit.kind === "none") hit = matchOne(projectQuery, await ensureProjects(deps, true));
  if (hit.kind === "none") {
    fail(`no project matching "${projectQuery}". Known projects:\n${formatCandidates(await ensureProjects(deps))}`);
  }
  if (hit.kind === "ambiguous") {
    fail(`ambiguous project "${projectQuery}":\n${formatCandidates(hit.candidates)}`);
  }
  return { id: hit.item.id, name: hit.item.name, viaAlias: null };
}

/** Resolve a user-typed name like "acme" or "Acme Website" to project + task ids. Alias names win. */
async function resolveProjectAndTask(deps: Deps, projectQuery: string, taskQuery?: string): Promise<Target> {
  const ref = await resolveProjectRef(deps, projectQuery);
  const projectId = ref.id;
  const projectName = ref.name;

  if (!taskQuery && ref.viaAlias?.taskId) {
    return { projectId, projectName, taskId: ref.viaAlias.taskId, taskName: ref.viaAlias.taskName ?? "" };
  }

  const tasks = await ensureTasks(deps, projectId);
  if (taskQuery) {
    const hit = matchOne(taskQuery, tasks);
    if (hit.kind === "none")
      fail(`no task matching "${taskQuery}" on ${projectName}. Tasks:\n${formatCandidates(tasks)}`);
    if (hit.kind === "ambiguous")
      fail(`ambiguous task "${taskQuery}" on ${projectName}:\n${formatCandidates(hit.candidates)}`);
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

/**
 * One entry line for the list views. The id leads so every edit/delete target
 * is visible without a --json detour; notes render in full.
 */
function entryLines(e: TimeEntry, deps: Deps, currency: string | null, conceal: boolean): string[] {
  const money = moneySuffix(sumMoney([e], deps.cfg), currency, deps.cfg, conceal);
  const marker = e.is_running ? " ▶" : "";
  return withNotes(`  ${e.id}  ${formatHours(e.hours)}${marker}  ${entryLabel(e)}${money}`, e.notes);
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
    lines.push(...entryLines(e, deps, currency, conceal));
  }
  return {
    text: lines.join("\n"),
    json: { running: runningJson, today, total: totalHours(today), totalAmount: todaySum.amount },
  };
}

/** Parse an --offset duration ("25m", "1:30", "1h30m") to hours; must be > 0. */
function parseOffsetHours(input: string): number {
  const h = parseHours(input);
  if (h === null || h <= 0) fail(`bad offset "${input}" (use e.g. 25m, 1:30, 1h30m)`);
  return h;
}

export async function cmdStart(
  deps: Deps,
  projectQuery: string,
  taskQuery?: string,
  notes?: string,
  opts: { offset?: string } = {},
): Promise<CmdResult> {
  // Validate before any API work (same fail-fast order as cmdLog's hours).
  const offsetHours = opts.offset !== undefined ? parseOffsetHours(opts.offset) : undefined;
  const target = await resolveProjectAndTask(deps, projectQuery, taskQuery);
  const stopped = await stopRunning(deps);
  const timestampTimers = await ensureTimerMode(deps);
  let entry = await deps.getApi().createTimeEntry(
    buildCreateEntryBody({
      timestampTimers,
      projectId: target.projectId,
      taskId: target.taskId,
      spentDate: localDateString(deps.now),
      notes,
      // Timestamp accounts backdate natively via started_time.
      hours: timestampTimers ? offsetHours : undefined,
      now: deps.now,
    }),
  );
  let headStart = "";
  if (!timestampTimers && offsetHours !== undefined) {
    // Base hours on a running timer: the server records the patch as
    // hours_without_timer and keeps the timer ticking on top.
    entry = await deps.getApi().request<TimeEntry>("PATCH", `/time_entries/${entry.id}`, { hours: offsetHours });
    headStart = ` (+${formatHours(offsetHours)} head start)`;
  }
  const lines: string[] = [];
  for (const s of stopped) lines.push(`■ stopped ${entryLabel(s)} (id ${s.id}) at ${formatHours(s.hours)}`);
  lines.push(
    ...withNotes(`▶ ${entryLabel(entry)} (id ${entry.id}) — started ${clockTime(deps.now)}${headStart}`, notes ?? null),
  );
  lines.push(...noteLinkWarnings(deps.cfg, entry));
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
    text: stopped.map((s) => `■ ${entryLabel(s)} (id ${s.id}) — stopped at ${formatHours(s.hours)}`).join("\n"),
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
  const lines = withNotes(
    `logged ${formatHours(hours)} → ${entryLabel(entry)} (${entry.spent_date}, id ${entry.id})`,
    entry.notes,
    "",
  );
  lines.push(...noteLinkWarnings(deps.cfg, entry));
  return {
    text: lines.join("\n"),
    json: { entry },
  };
}

/**
 * Project/task target for an edit move. Project: resolveProjectRef (alias
 * wins, id or fuzzy name). Task: an explicit --task wins; otherwise the
 * entry's task when the target project has it assigned (task ids are
 * account-global, so projects sharing a task set carry it over); otherwise
 * the project's single assigned task; otherwise fail — task sets differ
 * across projects, so guessing is not safe.
 */
async function resolveEditTarget(
  deps: Deps,
  entry: TimeEntry,
  opts: { project?: string; task?: string },
): Promise<{ projectId: number; taskId: number }> {
  const ref =
    opts.project !== undefined
      ? await resolveProjectRef(deps, opts.project)
      : { id: entry.project.id, name: entry.project.name };
  const tasks = await ensureTasks(deps, ref.id);
  if (opts.task !== undefined) {
    const hit = matchOne(opts.task, tasks);
    if (hit.kind === "none") fail(`no task matching "${opts.task}" on ${ref.name}. Tasks:\n${formatCandidates(tasks)}`);
    if (hit.kind === "ambiguous")
      fail(`ambiguous task "${opts.task}" on ${ref.name}:\n${formatCandidates(hit.candidates)}`);
    return { projectId: ref.id, taskId: hit.item.id };
  }
  if (tasks.some((t) => t.id === entry.task.id)) return { projectId: ref.id, taskId: entry.task.id };
  if (tasks.length === 1 && tasks[0]) return { projectId: ref.id, taskId: tasks[0].id };
  fail(`task "${entry.task.name}" is not on ${ref.name} and no --task given. Tasks:\n${formatCandidates(tasks)}`);
}

export async function cmdEdit(
  deps: Deps,
  entryId: string,
  opts: { hours?: string; notes?: string; date?: string; project?: string; task?: string },
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
  if (opts.project !== undefined || opts.task !== undefined) {
    const current = await deps.getApi().timeEntry(id);
    const target = await resolveEditTarget(deps, current, opts);
    if (opts.project !== undefined) body.project_id = target.projectId;
    body.task_id = target.taskId;
  }
  if (Object.keys(body).length === 0) fail("nothing to edit (use --hours, --note, --date, --project, or --task)");
  const entry = await deps.getApi().request<TimeEntry>("PATCH", `/time_entries/${id}`, body);
  const verb = body.project_id !== undefined || body.task_id !== undefined ? "moved" : "edited";
  const lines = withNotes(
    `${verb} ${entryLabel(entry)} (${entry.spent_date}, id ${entry.id}) → ${formatHours(entry.hours)}`,
    entry.notes,
    "",
  );
  lines.push(...noteLinkWarnings(deps.cfg, entry));
  return {
    text: lines.join("\n"),
    json: { entry },
  };
}

export async function cmdDelete(
  deps: Deps,
  entryId: string,
  opts: { force?: boolean; confirm?: () => Promise<boolean> } = {},
): Promise<CmdResult> {
  const id = Number(entryId);
  if (!Number.isInteger(id) || id <= 0) fail(`bad entry id "${entryId}"`);
  const entry = await deps.getApi().timeEntry(id);
  const summary = `${entryLabel(entry)} (${entry.spent_date}, ${formatHours(entry.hours)}, id ${entry.id})`;
  const summaryLines = withNotes(summary, entry.notes, "");
  if (!opts.force) {
    if (!opts.confirm) fail("refusing to delete without --force (non-interactive shell)");
    if (!(await opts.confirm())) return { text: "cancelled", json: { deleted: false, entry } };
  }
  await deps.getApi().deleteEntry(id);
  return {
    text: summaryLines.map((l, i) => (i === 0 ? `deleted ${l}` : l)).join("\n"),
    json: { deleted: true, entry },
  };
}

export async function cmdToday(deps: Deps, opts: { conceal?: boolean; groupBy?: GroupDim } = {}): Promise<CmdResult> {
  const conceal = opts.conceal === true;
  const today = await todayEntries(deps);
  const currency = await ensureCurrency(deps);
  const todaySum = sumMoney(today, deps.cfg);
  if (opts.groupBy) {
    const grouped = groupedLines(today, opts.groupBy, deps.cfg, currency, conceal);
    const lines = [
      `today: ${formatHours(todaySum.hours)} (${today.length} ${today.length === 1 ? "entry" : "entries"})${moneySuffix(todaySum, currency, deps.cfg, conceal)}`,
      ...grouped.lines,
    ];
    return {
      text: lines.join("\n"),
      json: { entries: today, total: totalHours(today), totalAmount: todaySum.amount, groups: grouped.groups },
    };
  }
  const lines = [
    `today: ${formatHours(todaySum.hours)} (${today.length} ${today.length === 1 ? "entry" : "entries"})${moneySuffix(todaySum, currency, deps.cfg, conceal)}`,
  ];
  for (const e of [...today].sort((a, b) => a.id - b.id)) {
    lines.push(...entryLines(e, deps, currency, conceal));
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

export type AuditIssue = "no-note" | "no-link" | "zero-hours" | "whole-hour" | "duplicate" | "locked";

const AUDIT_LABELS: Record<AuditIssue, string> = {
  "no-note": "no note",
  "no-link": "no link",
  "zero-hours": "zero hours",
  "whole-hour": "whole hour",
  duplicate: "possible duplicate",
  locked: "locked",
};

/** Whole-hour durations read as guessed logging; zero-duration entries are a different problem. */
export function isWholeHour(hours: number): boolean {
  const minutes = Math.round(hours * 60);
  return minutes > 0 && minutes % 60 === 0;
}

/** Data-quality flags for one entry, in report order. */
export function auditIssues(entry: TimeEntry, duplicate = false): AuditIssue[] {
  const issues: AuditIssue[] = [];
  if (!entry.notes || entry.notes.trim() === "") issues.push("no-note");
  else if (!noteHasLink(entry.notes)) issues.push("no-link");
  if (!entry.is_running) {
    if (entry.hours <= 0) issues.push("zero-hours");
    else if (isWholeHour(entry.hours)) issues.push("whole-hour");
  }
  if (duplicate) issues.push("duplicate");
  // Locked is an annotation, not a problem: a clean locked entry needs no action,
  // but a flagged one needs the timesheet reopened before it can be fixed.
  if (entry.is_locked && issues.length > 0) issues.push("locked");
  return issues;
}

/** Ids of stopped entries that repeat another entry's date, project, task, hours, and notes. */
export function duplicateEntryIds(entries: TimeEntry[]): Set<number> {
  const byKey = new Map<string, number[]>();
  for (const e of entries) {
    if (e.is_running) continue;
    const key = [e.spent_date, e.project.id, e.task.id, e.hours, e.notes ?? ""].join("|");
    byKey.set(key, [...(byKey.get(key) ?? []), e.id]);
  }
  const out = new Set<number>();
  for (const ids of byKey.values()) {
    if (ids.length > 1) for (const id of ids) out.add(id);
  }
  return out;
}

export interface AuditRangeOpts {
  month?: string;
  from?: string;
  to?: string;
  days?: string;
}

/** Resolve an audit range: a YYYY-MM month, --days N, or --from/--to. */
export function auditRange(now: Date, opts: AuditRangeOpts): { label: string; from: string; to: string } {
  const modes = [opts.month !== undefined, opts.days !== undefined, opts.from !== undefined || opts.to !== undefined];
  if (modes.filter(Boolean).length > 1) fail("pick one range: [YYYY-MM], --days N, or --from/--to");
  if (opts.days !== undefined) {
    const n = Number(opts.days);
    if (!Number.isInteger(n) || n <= 0) fail(`bad --days "${opts.days}" (positive integer)`);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1));
    return { label: `last ${n} ${n === 1 ? "day" : "days"}`, from: localDateString(start), to: localDateString(now) };
  }
  if (opts.from !== undefined || opts.to !== undefined) {
    if (opts.from === undefined || opts.to === undefined) fail("--from and --to go together");
    if (opts.from > opts.to) fail(`--from ${opts.from} is after --to ${opts.to}`);
    return { label: `${opts.from}..${opts.to}`, from: opts.from, to: opts.to };
  }
  return monthRange(opts.month, now);
}

/** Report-only scan of a date range for note and duration smells. */
export async function cmdAudit(deps: Deps, opts: AuditRangeOpts = {}): Promise<CmdResult> {
  const { label, from, to } = auditRange(deps.now, opts);
  const me = await ensureMe(deps);
  const entries = await deps.getApi().timeEntries({ user_id: me.id, from, to });
  const dupes = duplicateEntryIds(entries);
  const flagged = entries
    .map((entry) => ({ entry, issues: auditIssues(entry, dupes.has(entry.id)) }))
    .filter((f) => f.issues.length > 0)
    .sort((a, b) => a.entry.spent_date.localeCompare(b.entry.spent_date) || a.entry.id - b.entry.id);
  const lines: string[] = [];
  if (flagged.length === 0) {
    lines.push(`audit ${label}: nothing flagged (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`);
  } else {
    lines.push(`audit ${label}: ${flagged.length} of ${entries.length} entries flagged`);
    for (const { entry, issues } of flagged) {
      const tags = issues.map((i) => AUDIT_LABELS[i]).join(", ");
      lines.push(
        ...withNotes(
          `  ${entry.spent_date}  ${entry.id}  ${formatHours(entry.hours)}  ${entryLabel(entry)}  [${tags}]`,
          entry.notes,
        ),
      );
    }
  }
  return {
    text: lines.join("\n"),
    json: {
      range: label,
      from,
      to,
      total: entries.length,
      flagged: flagged.map(({ entry, issues }) => ({ ...entry, issues })),
    },
  };
}

export type GroupDim = "project" | "task" | "note";

function groupKey(dim: GroupDim, e: TimeEntry): string {
  if (dim === "project") return e.project.name;
  if (dim === "task") return `${e.project.name} / ${e.task.name}`;
  return (e.notes ? e.notes.split("\n")[0] : "") || "(no note)";
}

function groupEntries(entries: TimeEntry[], dim: GroupDim, cfg: HarvestConfig): { key: string; sum: MoneySum }[] {
  const map = new Map<string, MoneySum>();
  for (const e of entries) {
    const key = groupKey(dim, e);
    const sum = map.get(key) ?? { hours: 0, ratedHours: 0, amount: 0 };
    sum.hours += e.hours;
    const rate = entryRate(cfg, e);
    if (rate !== null) {
      sum.amount += e.hours * rate;
      sum.ratedHours += e.hours;
    }
    map.set(key, sum);
  }
  return [...map.entries()].sort((a, b) => b[1].hours - a[1].hours).map(([key, sum]) => ({ key, sum }));
}

function groupedLines(
  entries: TimeEntry[],
  dim: GroupDim,
  cfg: HarvestConfig,
  currency: string | null,
  conceal: boolean,
): { lines: string[]; groups: { key: string; hours: number; amount: number; ratedHours: number }[] } {
  const grouped = groupEntries(entries, dim, cfg);
  const lines = grouped.map(
    (g) => `  ${formatHours(g.sum.hours)}  ${g.key}${moneySuffix(g.sum, currency, cfg, conceal)}`,
  );
  return {
    lines,
    groups: grouped.map((g) => ({
      key: g.key,
      hours: g.sum.hours,
      amount: g.sum.amount,
      ratedHours: g.sum.ratedHours,
    })),
  };
}

export async function cmdMonth(
  deps: Deps,
  monthArg?: string,
  opts: { conceal?: boolean; groupBy?: GroupDim } = {},
): Promise<CmdResult> {
  const conceal = opts.conceal === true;
  const { label, from, to } = monthRange(monthArg, deps.now);
  const me = await ensureMe(deps);
  const entries = await deps.getApi().timeEntries({ user_id: me.id, from, to });
  const currency = await ensureCurrency(deps);

  // Exact tracked hours (raw `hours`, the rounding-agnostic ground truth).
  // Rate: config wins, entry rate fallback; the billable flag is
  // ignored — in practice the user's work is billable regardless of project flags.
  const byProject = new Map<string, MoneySum>();
  for (const e of entries) {
    const g = byProject.get(e.project.name) ?? { hours: 0, ratedHours: 0, amount: 0 };
    g.hours += e.hours;
    const rate = entryRate(deps.cfg, e);
    if (rate !== null) {
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
  const dim = opts.groupBy;
  if (dim) {
    lines.push(...groupedLines(entries, dim, deps.cfg, currency, conceal).lines);
  } else {
    for (const [name, g] of groups) {
      const amount = !conceal && g.ratedHours > 0 && currency ? ` — ${money(g.amount)}` : "";
      lines.push(`  ${formatHours(g.hours)}  ${name}${amount}`);
    }
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
      groups: dim
        ? groupEntries(entries, dim, deps.cfg).map((g) => ({
            key: g.key,
            hours: g.sum.hours,
            amount: g.sum.amount,
            ratedHours: g.sum.ratedHours,
          }))
        : groups.map(([name, g]) => ({
            key: name,
            hours: g.hours,
            amount: g.amount,
            ratedHours: g.ratedHours,
          })),
      totalHours,
      totalAmount,
    },
  };
}

export async function cmdWeek(deps: Deps, opts: { conceal?: boolean; groupBy?: GroupDim } = {}): Promise<CmdResult> {
  const conceal = opts.conceal === true;
  const me = await ensureMe(deps);
  const days = weekDates(deps.now);
  const entries = await deps.getApi().timeEntries({ user_id: me.id, from: days[0], to: days[days.length - 1] });
  const currency = await ensureCurrency(deps);
  if (opts.groupBy) {
    const grouped = groupedLines(entries, opts.groupBy, deps.cfg, currency, conceal);
    const lines = [
      `week: ${formatHours(totalHours(entries))}${moneySuffix(sumMoney(entries, deps.cfg), currency, deps.cfg, conceal)}`,
      ...grouped.lines,
    ];
    return { text: lines.join("\n"), json: { entries, total: totalHours(entries), groups: grouped.groups } };
  }
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
      lines.push(...entryLines(e, deps, currency, conceal));
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
  const ref = await resolveProjectRef(deps, projectQuery);
  const tasks = await ensureTasks(deps, ref.id);
  const cached = (await ensureProjects(deps)).find((p) => p.id === ref.id);
  const project = cached ?? { id: ref.id, name: ref.name, code: null, client: null };
  return {
    text: tasks.map((t) => `${t.id}  ${t.name}`).join("\n"),
    json: { project, tasks },
  };
}

export function aliasList(deps: Deps): CmdResult {
  const names = Object.keys(deps.cfg.aliases).sort();
  if (names.length === 0)
    return { text: "no aliases (set with: harvest alias <name> <project> [<task>])", json: { aliases: {} } };
  const lines = names.map((n) => {
    const a = deps.cfg.aliases[n];
    if (!a) return `  ${n}`;
    return `  ${n} → ${a.projectId}  ${a.projectName}${a.taskName ? ` / ${a.taskId}  ${a.taskName}` : ""}`;
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
