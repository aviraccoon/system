// Pure formatting and time helpers. No I/O.

export function parseHours(input: string): number | null {
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^(\d+)h(\d+)m?$/, "$1:$2")
    .replace(/^(\d+)m$/, "0:$1")
    .replace(/^(\d+)h$/, "$1:00");
  const hm = /^(\d+):(\d+)$/.exec(s);
  if (hm) return Number(hm[1]) + Number(hm[2]) / 60;
  const n = Number(s);
  if (!Number.isNaN(n) && s !== "") return n;
  return null;
}

export function formatHours(hours: number): string {
  const total = Math.round(hours * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** 4530 -> "4 530.00 CZK" (space-grouped, 2 decimals, currency code suffix). */
export function formatMoney(amount: number, currency: string): string {
  const [int, frac] = amount.toFixed(2).split(".");
  const grouped = (int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped}.${frac} ${currency}`;
}

export function formatElapsed(startedIso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(startedIso));
  const mins = Math.floor(ms / 60000);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, "0")}`;
}

/** Local yyyy-mm-dd for a Date (toISOString would use UTC). */
export function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Monday 00:00 local of the week containing d. */
export function mondayOf(d: Date): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (m.getDay() + 6) % 7; // 0 = Monday
  m.setDate(m.getDate() - day);
  return m;
}

/** The 7 local dates (yyyy-mm-dd) of the ISO week containing d. */
export function weekDates(d: Date): string[] {
  const out: string[] = [];
  const m = mondayOf(d);
  for (let i = 0; i < 7; i++) {
    out.push(localDateString(m));
    m.setDate(m.getDate() + 1);
  }
  return out;
}

/** Local clock time in Harvest's "8:00am" format (for timestamp-timer accounts). */
export function clockTime(d: Date): string {
  let h = d.getHours();
  const suffix = h < 12 ? "am" : "pm";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, "0")}${suffix}`;
}

/** Parse a local spent_date + "9:41am" into a Date. */
export function spentDateClockToDate(spentDate: string, clock: string): Date {
  const [y, mo, da] = spentDate.split("-").map(Number);
  if (y === undefined || mo === undefined || da === undefined) throw new Error(`unparseable date: ${spentDate}`);
  const m = /^([1-9][0-2]?):([0-5]\d)(am|pm)$/.exec(clock);
  if (!m) throw new Error(`unparseable clock time: ${clock}`);
  let h = Number(m[1]) % 12;
  if (m[3] === "pm") h += 12;
  return new Date(y, mo - 1, da, h, Number(m[2]));
}

/** Elapsed time for a running entry, handling both timer modes. */
export function entryElapsed(
  entry: { spent_date: string; timer_started_at: string | null; started_time: string | null },
  nowMs: number,
): string | null {
  if (entry.timer_started_at) return formatElapsed(entry.timer_started_at, nowMs);
  if (entry.started_time)
    return formatElapsed(spentDateClockToDate(entry.spent_date, entry.started_time).toISOString(), nowMs);
  return null;
}

/** Body for POST /time_entries. Duration accounts omit hours to start a running timer. */
export function buildCreateEntryBody(opts: {
  timestampTimers: boolean;
  projectId: number;
  taskId: number;
  spentDate: string;
  notes?: string;
  hours?: number;
  now: Date;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    project_id: opts.projectId,
    task_id: opts.taskId,
    spent_date: opts.spentDate,
  };
  if (opts.notes) body.notes = opts.notes;
  if (opts.hours !== undefined) {
    if (opts.timestampTimers) {
      // Timestamp accounts: derive start/end from the duration, ending now.
      body.started_time = clockTime(new Date(opts.now.getTime() - opts.hours * 3600_000));
      body.ended_time = clockTime(opts.now);
    } else {
      body.hours = opts.hours;
    }
  } else if (opts.timestampTimers) {
    body.started_time = clockTime(opts.now);
  }
  return body;
}
