// Pure helpers for raccache: formatting, protocol parsing, rate math,
// rendering. No IO here so everything is testable.

export interface TargetState {
  path: string;
  bytes: number;
  objects: number;
}

export interface SideState {
  label: string;
  paused: boolean;
  targets: TargetState[];
  info: string[];
  lastLog?: string;
  error?: string;
  at: number;
  sampled?: number;
}

export interface ParsedCollector {
  paused: boolean;
  units: Record<string, string>;
  timers: Record<string, number | undefined>;
  logs: Record<string, string>;
  progress: Record<string, string>;
  sampled?: number;
  sizes: TargetState[];
  notes: string[];
}

const SIZE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

export function fmtBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return "—";
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < SIZE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const text = i > 0 && v < 10 ? v.toFixed(1) : String(Math.round(v));
  return `${text} ${SIZE_UNITS[i]}`;
}

export function fmtRate(bytesPerSec: number): string {
  return `${fmtBytes(bytesPerSec)}/s`;
}

export function fmtAgo(ms: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One line for the pass running now: which destination/target pair of how many,
 * and how long it has been going. The pair list comes from the `raccache start`
 * line, so a narrowed pass (`--only`, `--destination`) reports its own scope; the
 * plan is the fallback for a start line written before that list existed.
 */
export function parseRunProgress(text: string, plan: string[], now = Date.now()): string | undefined {
  const starts = [...text.matchAll(/^(\S+) raccache start \(([^\n]*)\)$/gm)];
  const last = starts.at(-1);
  if (!last) return undefined;
  const section = text.slice(last.index);
  if (section.includes("raccache done")) return undefined;
  const listed = (last[2] ?? "")
    .slice((last[2] ?? "").indexOf(": ") + 2)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("/"));
  const fromStartLine = listed.length > 0;
  const pairs = fromStartLine ? listed : plan;
  if (pairs.length === 0) return undefined;
  // Older start lines carry only counts, so their section is written with
  // `<target> SKIPPED|ABORTED` instead of the pair label; that loose form would
  // match every destination sharing a target, so it is only used in the fallback.
  const names = (label: string): string[] => (fromStartLine ? [label] : [label, label.slice(label.indexOf("/") + 1)]);
  const done = pairs.filter((label) =>
    names(label).some((name) =>
      ["ok (", "FAILED", "ABORTED", "SKIPPED"].some((marker) => section.includes(` ${name} ${marker}`)),
    ),
  );
  const current = pairs.find((pair) => !done.includes(pair));
  const startedAt = Date.parse(last[1] ?? "");
  const elapsed = Number.isFinite(startedAt) ? fmtAgo(startedAt, now) : undefined;
  const position = current ? done.length + 1 : pairs.length;
  return `${position} of ${pairs.length} (${current ?? "finishing"})${elapsed ? ` · ${elapsed} elapsed` : ""}`;
}
export function fmtIn(epochSeconds: number, now: number): string {
  const seconds = Math.round(epochSeconds - now / 1000);
  if (seconds <= 0) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d`;
}

function parseEpoch(value: string): number | undefined {
  const raw = value.trim();
  const trimmed = raw.startsWith("@") ? raw.slice(1) : raw;
  if (!trimmed || trimmed === "-") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n > 1_000_000_000_000 ? Math.floor(n / 1_000_000) : n;
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}

export function parseCollector(text: string): ParsedCollector {
  const out: ParsedCollector = { paused: false, units: {}, timers: {}, logs: {}, progress: {}, sizes: [], notes: [] };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const split = line.indexOf(" ");
    if (split < 0) continue;
    const kind = line.slice(0, split);
    const rest = line.slice(split + 1);
    if (kind === "PAUSED") {
      out.paused = rest.trim() === "1";
    } else if (kind === "UNIT" || kind === "TIMER") {
      const sp = rest.indexOf(" ");
      const name = sp < 0 ? rest : rest.slice(0, sp);
      const value = sp < 0 ? "" : rest.slice(sp + 1);
      if (kind === "UNIT") out.units[name] = value;
      else out.timers[name] = parseEpoch(value);
    } else if (kind === "LOG" || kind === "PROGRESS") {
      const sp = rest.indexOf(" ");
      const name = sp < 0 ? rest : rest.slice(0, sp);
      const value = sp < 0 ? "" : rest.slice(sp + 1);
      if (kind === "LOG") out.logs[name] = value;
      else out.progress[name] = value;
    } else if (kind === "SAMPLED") {
      const value = Number(rest.trim());
      if (Number.isFinite(value) && value > 0) out.sampled = value;
    } else if (kind === "NOTE") {
      out.notes.push(rest.trim());
    } else if (kind === "SIZE") {
      const sp = rest.indexOf(" ");
      const path = sp < 0 ? rest : rest.slice(0, sp);
      let bytes = 0;
      let objects = 0;
      try {
        const parsed = JSON.parse(sp < 0 ? "{}" : rest.slice(sp + 1)) as { count?: number; bytes?: number };
        bytes = parsed.bytes ?? 0;
        objects = parsed.count ?? 0;
      } catch {
        // keep zeros; a missing size renders as 0 B
      }
      out.sizes.push({ path, bytes, objects });
    }
  }
  return out;
}

export function parseTransferLine(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const text = line.replace(/^Transferred:\s*/, "").trim();
  return text && text !== "-" ? text : undefined;
}

export function computeRates(prev: SideState | undefined, cur: SideState): Record<string, number> {
  const rates: Record<string, number> = {};
  if (!prev) return rates;
  // Rate window is between size samples, not between snapshots: the server
  // serves cached sizes for SIZE_TTL seconds, and dividing a stale delta by a
  // shorter gap would overstate the rate.
  const sampleDelta = (cur.sampled ?? cur.at) - (prev.sampled ?? prev.at);
  const seconds = sampleDelta / 1000;
  if (seconds <= 0) return rates;
  const before = new Map(prev.targets.map((t) => [t.path, t.bytes]));
  for (const target of cur.targets) {
    const from = before.get(target.path);
    if (from !== undefined && target.bytes >= from) rates[target.path] = (target.bytes - from) / seconds;
  }
  return rates;
}

export function renderSide(side: SideState, rates: Record<string, number> | undefined, now: Date): string {
  const flags: string[] = [`${fmtAgo(side.at, now.getTime())} ago`];
  if (side.paused) flags.push("PAUSED");
  if (side.error) flags.push(`error: ${side.error}`);
  const lines: string[] = [`${side.label} · ${flags.join(" · ")}`];

  const width = Math.min(28, Math.max(...side.targets.map((t) => t.path.length), 8));
  for (const target of side.targets) {
    const rate = rates?.[target.path];
    const name = target.path.length > width ? `${target.path.slice(0, width - 1)}…` : target.path.padEnd(width);
    const bytes = fmtBytes(target.bytes).padStart(10);
    const suffix = rate === undefined ? "" : `  ${fmtRate(rate).padStart(12)}`;
    lines.push(`  ${name}  ${bytes}${suffix}`);
  }
  for (const info of side.info) lines.push(`  ${info}`);
  if (side.lastLog) lines.push(`  log    ${side.lastLog.slice(0, 140)}`);
  return lines.join("\n");
}
