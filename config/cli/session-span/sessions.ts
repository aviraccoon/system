// Reading and analyzing pi's JSONL session logs.
//
// A session file is one JSON object per line; the first row is the session
// header (`type: "session"`, `version`). A conversation can rotate into a new
// file after compaction, replaying the earlier rows with their original ids and
// timestamps — a lineage. Rows here carry only what the measurement needs: time, role,
// recorded operation duration, and tool-call pairing.

export const SESSION_VERSION = 3;

export interface SessionRow {
  id: string;
  /** Epoch ms. */
  time: number;
  /** `user` | `assistant` | `toolResult` | `system` | the row's `type` for non-message rows. */
  role: string;
  /** Recorded duration of the operation the row reports, when it carries one. */
  durationMs: number | null;
  /** Tool calls emitted by this row. */
  toolCallIds: string[];
  /** For result rows: the call they answer. */
  toolCallId: string | null;
}

export interface SessionFile {
  path: string;
  cwd: string | null;
  rows: SessionRow[];
}

export interface Lineage {
  files: string[];
  cwd: string | null;
  /** Deduped replay rows, ascending by time. */
  rows: SessionRow[];
}

export type GapKind = "idle" | "work" | "unknown";

export interface Gap {
  start: number;
  end: number;
  minutes: number;
  kind: GapKind;
  /** Why the gap counts as work, when it does. */
  evidence: string | null;
  /** Role of the row before the gap. */
  from: string;
  /** Role of the row after the gap. */
  to: string;
}

interface Part {
  type?: unknown;
  id?: unknown;
}

interface RawRow {
  id?: unknown;
  type?: unknown;
  version?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  message?: {
    role?: unknown;
    durationMs?: unknown;
    toolCallId?: unknown;
    content?: unknown;
  };
}

/** Parses one session file. Throws on malformed lines or an unknown session version. */
export function parseSessionFile(path: string, content: string): SessionFile {
  const rows: SessionRow[] = [];
  let version: number | null = null;
  let cwd: string | null = null;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    let raw: RawRow;
    try {
      raw = JSON.parse(line) as RawRow;
    } catch {
      throw new Error(`${path}:${i + 1}: not JSON`);
    }
    if (raw.type === "session") {
      if (typeof raw.version !== "number") throw new Error(`${path}:${i + 1}: session row without version`);
      version = raw.version;
      cwd = typeof raw.cwd === "string" ? raw.cwd : null;
      continue;
    }
    if (typeof raw.id !== "string") throw new Error(`${path}:${i + 1}: row without id`);
    if (typeof raw.timestamp !== "string") throw new Error(`${path}:${i + 1}: row without timestamp`);
    const time = Date.parse(raw.timestamp);
    if (Number.isNaN(time)) throw new Error(`${path}:${i + 1}: unparseable timestamp "${raw.timestamp}"`);

    const message = raw.message;
    const role = typeof message?.role === "string" ? message.role : String(raw.type ?? "unknown");
    const toolCallIds: string[] = [];
    if (Array.isArray(message?.content)) {
      for (const part of message.content as Part[]) {
        if (part?.type === "toolCall" && typeof part.id === "string") toolCallIds.push(part.id);
      }
    }
    rows.push({
      id: raw.id,
      time,
      role,
      durationMs: typeof message?.durationMs === "number" ? message.durationMs : null,
      toolCallIds,
      toolCallId: typeof message?.toolCallId === "string" ? message.toolCallId : null,
    });
  }

  if (version === null) throw new Error(`${path}: no session header`);
  if (version !== SESSION_VERSION) {
    throw new Error(`${path}: session version ${version}, expected ${SESSION_VERSION} — format changed?`);
  }
  return { path, cwd, rows };
}

/**
 * Groups files into lineages by shared row ids (a rotated file replays the
 * earlier one), dedupes the replayed rows, and sorts each lineage by time.
 * Unrelated sessions share no ids and stay separate.
 */
export function groupLineages(files: SessionFile[]): Lineage[] {
  const groups: Array<{ files: string[]; cwd: string | null; ids: Set<string>; rows: Map<string, SessionRow> }> = [];

  for (const file of files) {
    const fileIds = new Set(file.rows.map((row) => row.id));
    const merged = {
      files: [] as string[],
      cwd: file.cwd,
      ids: new Set<string>(),
      rows: new Map<string, SessionRow>(),
    };
    const rest: typeof groups = [];
    for (const group of groups) {
      let overlaps = false;
      for (const id of group.ids) {
        if (fileIds.has(id)) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        rest.push(group);
        continue;
      }
      for (const path of group.files) merged.files.push(path);
      for (const id of group.ids) merged.ids.add(id);
      for (const [id, row] of group.rows) if (!merged.rows.has(id)) merged.rows.set(id, row);
      if (merged.cwd === null) merged.cwd = group.cwd;
    }
    merged.files.push(file.path);
    for (const id of fileIds) merged.ids.add(id);
    for (const row of file.rows) if (!merged.rows.has(row.id)) merged.rows.set(row.id, row);
    rest.push(merged);
    groups.length = 0;
    groups.push(...rest);
  }

  return groups
    .map((group) => ({
      files: [...group.files].sort(),
      cwd: group.cwd,
      rows: [...group.rows.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)),
    }))
    .filter((lineage) => lineage.rows.length > 0)
    .sort((a, b) => (a.rows[0]?.time ?? 0) - (b.rows[0]?.time ?? 0));
}

/**
 * Classifies the gap between every pair of consecutive rows. A gap is work when
 * the row after it records an operation covering the gap, or when it is the run
 * of a tool call the row before it emitted; it is idle when nothing explains it
 * and it reaches `idleMinutes`; otherwise unknown. Callers filter what they
 * list; `activeMinutes` needs every gap.
 */
export function findGaps(rows: SessionRow[], idleMinutes = 15): Gap[] {
  const gaps: Gap[] = [];

  for (let i = 0; i < rows.length - 1; i++) {
    const left = rows[i];
    const right = rows[i + 1];
    if (!left || !right) continue;
    const gapMs = right.time - left.time;

    const evidence = workEvidence(left, right, gapMs);
    const minutes = gapMs / 60_000;
    const kind: GapKind = evidence ? "work" : gapMs >= idleMinutes * 60_000 ? "idle" : "unknown";
    gaps.push({ start: left.time, end: right.time, minutes, kind, evidence, from: left.role, to: right.role });
  }

  return gaps;
}

/**
 * Evidence that the gap is attended work. The row after the gap carries the
 * duration of the operation that produced it (a tool run or a model call); a
 * tool call answered by the row after the gap covers it too. The row before the
 * gap is not consulted: its duration describes the segment ending at it.
 */
function workEvidence(left: SessionRow, right: SessionRow, gapMs: number): string | null {
  const toleranceMs = 60_000;
  if (right.durationMs !== null && Math.abs(gapMs - right.durationMs) <= toleranceMs) {
    return `op ${formatDuration(right.durationMs)}`;
  }
  if (right.toolCallId !== null && left.toolCallIds.includes(right.toolCallId)) return "tool call";
  return null;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${(seconds / 60).toFixed(1)} min`;
}

/** Minutes from the first to the last row, minus the idle gaps. */
export function activeMinutes(rows: SessionRow[], gaps: Gap[]): number {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return 0;
  const span = (last.time - first.time) / 60_000;
  const idle = gaps.reduce((sum, gap) => (gap.kind === "idle" ? sum + gap.minutes : sum), 0);
  return span - idle;
}

export interface LineageReport {
  files: string[];
  cwd: string | null;
  rows: number;
  first: number;
  last: number;
  spanMinutes: number;
  /** Every gap, classified; renderers filter what they list. */
  gaps: Gap[];
  activeMinutes: number;
  idleMinutes: number;
  assistantTurns: number;
  userTurns: number;
  /** Minutes since the last row against the run's clock; null without one. */
  lastRowAgoMinutes: number | null;
}

export interface ReportOptions {
  idleMinutes: number;
  /** Clock to measure `lastRowAgoMinutes` against; without it the age is null. */
  now?: number;
}

/** One lineage's span, gaps, active time, and shape. */
export function buildReport(lineage: Lineage, opts: ReportOptions): LineageReport {
  const first = lineage.rows[0]?.time ?? 0;
  const last = lineage.rows[lineage.rows.length - 1]?.time ?? 0;
  const gaps = findGaps(lineage.rows, opts.idleMinutes);
  const active = activeMinutes(lineage.rows, gaps);
  return {
    files: lineage.files,
    cwd: lineage.cwd,
    rows: lineage.rows.length,
    first,
    last,
    spanMinutes: (last - first) / 60_000,
    gaps,
    activeMinutes: active,
    idleMinutes: (last - first) / 60_000 - active,
    assistantTurns: lineage.rows.filter((row) => row.role === "assistant").length,
    userTurns: lineage.rows.filter((row) => row.role === "user").length,
    lastRowAgoMinutes: opts.now === undefined || last === 0 ? null : Math.max(0, (opts.now - last) / 60_000),
  };
}
