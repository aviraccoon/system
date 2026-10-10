// Clocks, day labels, and the text report. Time zones are parameters so tests
// can pin them instead of depending on the machine's zone.

import type { GapKind, LineageReport } from "./sessions";

export function localDay(epochMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs));
}

/** Shifts a `YYYY-MM-DD` label by whole days, calendar-safe. */
export function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (date ?? 1) + days));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function clock(epochMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(epochMs));
}

export function utcClock(epochMs: number): string {
  return `${clock(epochMs, "UTC")}Z`;
}

/** Minutes as `H:MM` (97 → `1:37`). */
export function formatHm(minutes: number): string {
  const total = Math.round(minutes);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function oneDecimal(value: number): string {
  return value.toFixed(1);
}

/**
 * A `HH:MM[:SS]` clock on `day`, read in `timeZone` (default: the host's).
 * Temporal's `compatible` disambiguation: a wall time that occurs twice (DST
 * fall-back) takes the earlier instant, and one that does not exist
 * (spring-forward gap) shifts forward, past the gap.
 */
export function zonedEpoch(day: string, value: string, timeZone?: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const [hour, minute, second] = value.split(":").map(Number);
  return Temporal.ZonedDateTime.from(
    {
      timeZone: timeZone ?? Temporal.Now.timeZoneId(),
      year: year ?? 0,
      month: month ?? 1,
      day: date ?? 1,
      hour: hour ?? 0,
      minute: minute ?? 0,
      second: second ?? 0,
    },
    { disambiguation: "compatible" },
  ).epochMilliseconds;
}

export function renderText(reports: LineageReport[], opts: { timeZone?: string; reportMinutes?: number } = {}): string {
  const blocks = reports.map((report) => {
    const timeZone = opts.timeZone;
    const reportMinutes = opts.reportMinutes ?? 5;
    const lines = [
      `session ${localDay(report.first, timeZone)} ${clock(report.first, timeZone)} → ${clock(report.last, timeZone)} local (${utcClock(report.first)} → ${utcClock(report.last)})`,
      `  ${report.cwd ?? "unknown cwd"} — ${report.rows} rows, ${report.files.length} file${report.files.length === 1 ? "" : "s"}`,
    ];
    for (const file of report.files) lines.push(`  file ${file}`);
    lines.push(
      `  span ${oneDecimal(report.spanMinutes)} min (${formatHm(report.spanMinutes)}), active ${oneDecimal(report.activeMinutes)} min (${formatHm(report.activeMinutes)}), idle ${oneDecimal(report.idleMinutes)} min`,
    );
    lines.push(`  messages ${report.assistantTurns} assistant, ${report.userTurns} user`);
    if (report.lastRowAgoMinutes !== null) {
      lines.push(`  last row ${oneDecimal(report.lastRowAgoMinutes)} min ago`);
    }
    const listed = report.gaps.filter((gap) => gap.minutes >= reportMinutes);
    if (listed.length === 0) {
      lines.push(`  gaps: none ≥${reportMinutes} min`);
    } else {
      for (const gap of listed) {
        const details = [gap.evidence, `${gap.from} → ${gap.to}`].filter(Boolean).join(", ");
        lines.push(
          `  gap ${oneDecimal(gap.minutes)} min ${gap.kind} (${details}) ${clock(gap.start, timeZone)} → ${clock(gap.end, timeZone)}`,
        );
      }
    }
    return lines.join("\n");
  });
  const text = blocks.join("\n\n");
  if (reports.length < 2) return text;
  const span = reports.reduce((sum, report) => sum + report.spanMinutes, 0);
  const active = reports.reduce((sum, report) => sum + report.activeMinutes, 0);
  const idle = reports.reduce((sum, report) => sum + report.idleMinutes, 0);
  return `${text}\n\n${reports.length} sessions: span ${oneDecimal(span)} min (${formatHm(span)}), active ${oneDecimal(active)} min (${formatHm(active)}), idle ${oneDecimal(idle)} min`;
}

export interface JsonReport {
  first: string;
  last: string;
  firstLocal: string;
  lastLocal: string;
  cwd: string | null;
  files: string[];
  rows: number;
  spanMinutes: number;
  activeMinutes: number;
  idleMinutes: number;
  assistantTurns: number;
  userTurns: number;
  lastRowAgoMinutes: number | null;
  gaps: Array<{
    minutes: number;
    kind: GapKind;
    evidence: string | null;
    from: string;
    to: string;
    start: string;
    end: string;
  }>;
}

export interface JsonOutput {
  reports: JsonReport[];
  totals: { sessions: number; spanMinutes: number; activeMinutes: number; idleMinutes: number };
}

export function renderJson(
  reports: LineageReport[],
  opts: { timeZone?: string; reportMinutes?: number } = {},
): JsonOutput {
  const reportMinutes = opts.reportMinutes ?? 5;
  const round = (value: number) => Number(value.toFixed(1));
  const jsonReports = reports.map((report) => ({
    first: new Date(report.first).toISOString(),
    last: new Date(report.last).toISOString(),
    firstLocal: `${localDay(report.first, opts.timeZone)} ${clock(report.first, opts.timeZone)}`,
    lastLocal: `${localDay(report.last, opts.timeZone)} ${clock(report.last, opts.timeZone)}`,
    cwd: report.cwd,
    files: report.files,
    rows: report.rows,
    spanMinutes: round(report.spanMinutes),
    activeMinutes: round(report.activeMinutes),
    idleMinutes: round(report.idleMinutes),
    assistantTurns: report.assistantTurns,
    userTurns: report.userTurns,
    lastRowAgoMinutes: report.lastRowAgoMinutes === null ? null : round(report.lastRowAgoMinutes),
    gaps: report.gaps
      .filter((gap) => gap.minutes >= reportMinutes)
      .map((gap) => ({
        minutes: round(gap.minutes),
        kind: gap.kind,
        evidence: gap.evidence,
        from: gap.from,
        to: gap.to,
        start: new Date(gap.start).toISOString(),
        end: new Date(gap.end).toISOString(),
      })),
  }));
  return {
    reports: jsonReports,
    totals: {
      sessions: reports.length,
      spanMinutes: round(reports.reduce((sum, report) => sum + report.spanMinutes, 0)),
      activeMinutes: round(reports.reduce((sum, report) => sum + report.activeMinutes, 0)),
      idleMinutes: round(reports.reduce((sum, report) => sum + report.idleMinutes, 0)),
    },
  };
}
