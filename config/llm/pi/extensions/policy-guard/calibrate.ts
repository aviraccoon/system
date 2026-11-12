/**
 * Calibrate a clause's threshold from the decision log.
 *
 * The log records what the judge said, not whether it was right, so a refusal's label is
 * inferred from what happened next in the same session:
 *
 * - the session's next record, within the window, is an unlock that covers the refused
 *   surface: the user **overrode** the refusal, since it fired and the user unlocked the
 *   session anyway. A host grant covers bash only, while `/guard off` covers every surface;
 * - the session's next record is a call the judge cleared: the refusal **stood**; nothing
 *   answered it.
 *
 * Both are proxies, and neither is ground truth: an unlock lasts for the rest of the session,
 * so it can override a later refusal rather than the one before it, and a cleared call need
 * not be related to the refused work. A revoked grant is not recorded at all, so a refusal the
 * user overrode and then revoked still reads as overridden. The report names the label it used,
 * not "right"/"wrong".
 * A threshold is suggested only when the labels separate: every override below it and
 * every standing refusal above it. With too few labels of either class there is nothing
 * to fit, and the report says which side is missing rather than guessing.
 *
 * The log is shared by every project, and a clause id means a different thing in each, so a
 * fit reads one project's records.
 *
 * Run: bun run extensions/policy-guard/calibrate.ts [--bench [--policy <name>]] [--project <name>] [path]
 *
 * No pi imports. Tests run under bun.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliSpec, ParsedCli } from "../../../../shared/cli";
import { type GuardDecision, parseDecisions } from "./decisions";

export interface CalibrationOptions {
  /** How soon after a refusal an unlock counts as overriding it. */
  overrideWindowMs?: number;
  /** Labels of each class needed before a threshold is suggested. */
  minLabels?: number;
}

/** A refusal's label: the user overrode it, or nothing answered it. */
export interface LabeledRefusal {
  clause: string;
  score: number;
  label: "stood" | "overridden";
}

/**
 * One clause's counts and fit. `stood` and `overridden` are refusals in log mode and hand
 * labels in benchmark mode: a benchmark case is written as a refusal the clause should cite
 * (`stood`) or as a call the policy allows (`overridden`), so neither count is an observation.
 */
export interface ClauseReport {
  clause: string;
  /** Calls whose answers included this clause (log) or cases that scored it (benchmark). */
  judged: number;
  /** Refusals that cited it (log) or cases written to cite it (benchmark). */
  cited: number;
  /** Refusals nothing overrode (log) or cases a refusal was expected on (benchmark). */
  stood: number;
  /** Refusals an unlock overrode (log) or cases labeled as allowed (benchmark). */
  overridden: number;
  lowestStood: number | null;
  highestOverridden: number | null;
  /** A threshold that separates the labels, or null with `note` saying why not. */
  suggested: number | null;
  note: string;
}

const DEFAULT_OVERRIDE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MIN_LABELS = 5;

/**
 * The score a refusal carries for its own clause. A record's `scores` holds it; a record that
 * carries none (an older line) falls back to the verdict probability, which on a refusal is
 * the cited clause's own answer: `verdictFromAnswers` sets it to the strongest firing clause,
 * the one it cites.
 */
function refusalScore(decision: GuardDecision): number | null {
  if (decision.clause === null) return null;
  const own = decision.scores[decision.clause];
  return typeof own === "number" ? own : decision.probability;
}

/** Whether an unlock could have unlocked this refusal: `*` covers every surface. */
function unlockCovers(unlock: GuardDecision, refusal: GuardDecision): boolean {
  // A record that predates `tool` carries none, and two of those must not match each other.
  return unlock.tool !== "" && (unlock.tool === "*" || unlock.tool === refusal.tool);
}

/** Refusals with inferred labels, oldest first within each session. */
export function labelRefusals(decisions: GuardDecision[], options: CalibrationOptions = {}): LabeledRefusal[] {
  const window = options.overrideWindowMs ?? DEFAULT_OVERRIDE_WINDOW_MS;
  const bySession = new Map<string, GuardDecision[]>();
  for (const decision of decisions) {
    const list = bySession.get(decision.session);
    if (list) list.push(decision);
    else bySession.set(decision.session, [decision]);
  }

  const labeled: LabeledRefusal[] = [];
  for (const records of bySession.values()) {
    const sorted = [...records].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    sorted.forEach((record, index) => {
      if (!record.violated || record.clause === null) return;
      const score = refusalScore(record);
      if (score === null) return;
      // A verdict that came from part of the policy is not evidence about this clause.
      if (record.missing.length > 0) return;
      // The next record answers the refusal or forecloses it; a floor refusal, a second
      // refusal and an allowed call all end the search the same way.
      const next = sorted[index + 1];
      if (
        next?.kind === "unlock" &&
        Date.parse(next.at) - Date.parse(record.at) <= window &&
        unlockCovers(next, record)
      ) {
        labeled.push({ clause: record.clause, score, label: "overridden" });
        return;
      }
      if (next?.kind === "policy" && !next.violated) {
        labeled.push({ clause: record.clause, score, label: "stood" });
      }
    });
  }
  return labeled;
}

/**
 * Fold labeled refusals into one suggestion per clause, for one project's records only. A
 * clause id is meaningful within a project, so another project's `deps` would fit this one's
 * threshold on a different rule.
 */
export function calibrationReport(
  decisions: GuardDecision[],
  project: string,
  options: CalibrationOptions = {},
): ClauseReport[] {
  const mine = project === "" ? [] : decisions.filter((decision) => decision.project === project);
  const minLabels = options.minLabels ?? DEFAULT_MIN_LABELS;
  const judged = new Map<string, number>();
  const cited = new Map<string, number>();
  for (const decision of mine) {
    // A record from before per-clause scores existed still names the clause it cited, so
    // that clause counts as judged even though its score is only the verdict's.
    const seen = new Set(Object.keys(decision.scores));
    if (decision.clause !== null) seen.add(decision.clause);
    for (const clause of seen) judged.set(clause, (judged.get(clause) ?? 0) + 1);
    if (decision.kind === "policy" && decision.violated && decision.clause !== null) {
      cited.set(decision.clause, (cited.get(decision.clause) ?? 0) + 1);
    }
  }

  const labels = labelRefusals(mine, options);
  const clauses = new Set([...judged.keys(), ...cited.keys()]);
  return [...clauses].sort().map((clause) => {
    const labelsHere = labels.filter((entry) => entry.clause === clause);
    const stood = labelsHere.filter((entry) => entry.label === "stood").map((entry) => entry.score);
    const overridden = labelsHere.filter((entry) => entry.label === "overridden").map((entry) => entry.score);
    const fit = suggestThreshold(stood, overridden, minLabels);
    return {
      clause,
      judged: judged.get(clause) ?? 0,
      cited: cited.get(clause) ?? 0,
      stood: stood.length,
      overridden: overridden.length,
      lowestStood: stood.length > 0 ? Math.min(...stood) : null,
      highestOverridden: overridden.length > 0 ? Math.max(...overridden) : null,
      suggested: fit.suggested,
      note: fit.note,
    };
  });
}

/**
 * A threshold that separates the labels, or a note saying why not.
 *
 * `verdictFromAnswers` fires at `score >= threshold`, so the suggestion has to stay above
 * every overridden score and at or below every standing one; an unrounded midpoint keeps
 * it strictly between them.
 */
export function suggestThreshold(
  stood: number[],
  overridden: number[],
  minLabels: number = DEFAULT_MIN_LABELS,
): { suggested: number | null; note: string } {
  if (stood.length < minLabels || overridden.length < minLabels) {
    return {
      suggested: null,
      note: `needs ${minLabels} labels of each class, has ${stood.length} standing and ${overridden.length} overridden`,
    };
  }
  const lowestStood = Math.min(...stood);
  const highestOverridden = Math.max(...overridden);
  if (lowestStood <= highestOverridden) {
    return {
      suggested: null,
      note: `the classes overlap: a refusal that stood scores ${lowestStood.toFixed(3)}, an overridden one ${highestOverridden.toFixed(3)}`,
    };
  }
  return {
    suggested: (lowestStood + highestOverridden) / 2,
    note: `standing refusals from ${lowestStood.toFixed(3)}, overridden ones up to ${highestOverridden.toFixed(3)}`,
  };
}

/** One policy row from `BENCH_DUMP=… bun run benchmarks/policy.ts`. */
export interface BenchRow {
  id: string;
  policy: string;
  expected: boolean;
  expectedClause: string | null;
  scores: Record<string, number>;
}

/**
 * Per-clause reports over a benchmark dump. The cases are labeled by hand and ask the same
 * per-clause questions, so `stood` counts the cases written to cite the clause and
 * `overridden` the cases written as allowed. Neither is a session observation, and the CLI
 * says so under the table. The rows come from one policy, so each row is one case.
 */
export function calibrationFromBench(rows: BenchRow[], options: CalibrationOptions = {}): ClauseReport[] {
  const minLabels = options.minLabels ?? DEFAULT_MIN_LABELS;
  const clauses = new Set<string>();
  for (const row of rows) for (const clause of Object.keys(row.scores ?? {})) clauses.add(clause);

  return [...clauses].sort().map((clause) => {
    const scoreOf = (row: BenchRow): number | null =>
      typeof row.scores?.[clause] === "number" ? row.scores[clause] : null;
    const stood = rows
      .filter((row) => row.expected && row.expectedClause === clause)
      .map(scoreOf)
      .filter((score): score is number => score !== null);
    const overridden = rows
      .filter((row) => !row.expected)
      .map(scoreOf)
      .filter((score): score is number => score !== null);
    const fit = suggestThreshold(stood, overridden, minLabels);
    return {
      clause,
      judged: stood.length + overridden.length,
      cited: stood.length,
      stood: stood.length,
      overridden: overridden.length,
      lowestStood: stood.length > 0 ? Math.min(...stood) : null,
      highestOverridden: overridden.length > 0 ? Math.max(...overridden) : null,
      suggested: fit.suggested,
      note: fit.note,
    };
  });
}

/**
 * The policy runs in a dump: one JSON object per line, `{ kind: "policy", policy, rows }`.
 * Unparsable lines are skipped, the way the log reader skips a truncated line, because the
 * dump is a file another script wrote. A row without scores is kept and scores nothing; a
 * row without an id or an expectation is dropped.
 */
export function readBenchDump(raw: string, policy?: string): { rows: BenchRow[]; policies: string[] } {
  const rows: BenchRow[] = [];
  const policies = new Set<string>();
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let entry: { kind?: string; policy?: string; rows?: unknown[] };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.kind !== "policy" || typeof entry.policy !== "string" || !Array.isArray(entry.rows)) continue;
    policies.add(entry.policy);
    if (policy !== undefined && entry.policy !== policy) continue;
    for (const row of entry.rows) {
      const candidate = row as Partial<BenchRow> | null;
      if (!candidate || typeof candidate.id !== "string" || typeof candidate.expected !== "boolean") continue;
      // Same tolerance as the log: a score that is not a number is dropped, not compared.
      const scores: Record<string, number> = {};
      if (typeof candidate.scores === "object" && candidate.scores !== null) {
        for (const [clause, score] of Object.entries(candidate.scores)) {
          if (typeof score === "number" && Number.isFinite(score)) scores[clause] = score;
        }
      }
      rows.push({
        id: candidate.id,
        policy: entry.policy,
        expected: candidate.expected,
        expectedClause: typeof candidate.expectedClause === "string" ? candidate.expectedClause : null,
        scores,
      });
    }
  }
  return { rows, policies: [...policies].sort() };
}

/**
 * The report as lines, one clause each. Three decimals, so an unrounded midpoint a
 * thousandth above the highest overridden score still prints above it; `empty` is printed
 * when no clause has a report, and the caller says which source had nothing.
 */
export function formatReport(
  reports: ClauseReport[],
  empty: string = "no judged calls in the log yet: nothing to calibrate",
): string[] {
  if (reports.length === 0) return [empty];
  return reports.map((report) => {
    const head = `${report.clause}: ${report.judged} judged, ${report.cited} cited, ${report.stood} stood, ${report.overridden} overridden`;
    return report.suggested === null
      ? `${head}; no suggestion (${report.note})`
      : `${head}; threshold ${report.suggested.toFixed(3)} (${report.note})`;
  });
}

/** A report and the line under it, so what the CLI prints is a value a test can read. */
export interface SourceReport {
  lines: string[];
  footer: string;
}

/** One project's fit from a log, and the line that says what was read. */
export function logReport(decisions: GuardDecision[], project: string, path: string): SourceReport {
  const mine = decisions.filter((decision) => decision.project === project);
  // A project can hold records and no scores (floor refusals, unlocks), which is not an empty log.
  const empty =
    mine.length > 0
      ? "no clause scores in this project's records: nothing to calibrate"
      : "no judged calls in the log yet: nothing to calibrate";
  const scope = project === "" ? "" : ` (${project})`;
  const count = `${mine.length} ${mine.length === 1 ? "record" : "records"}`;
  return {
    lines: formatReport(calibrationReport(decisions, project), empty),
    footer: `${count} read from ${path}${scope}`,
  };
}

/** One policy's fit from a benchmark dump, and the line that says what was read. */
export function benchReport(rows: BenchRow[], path: string, policy: string): SourceReport {
  const count = `${rows.length} benchmark ${rows.length === 1 ? "row" : "rows"}`;
  return {
    lines: formatReport(calibrationFromBench(rows), "no clause scores in this dump: nothing to calibrate"),
    footer: `${count} read from ${path} (${policy || "any policy"}); every count is the cases' hand label, not a session observation`,
  };
}

/** The projects named in a log's records, sorted. A record with no project is not fitted. */
export function projectsIn(decisions: GuardDecision[]): string[] {
  return [...new Set(decisions.map((decision) => decision.project).filter((project) => project !== ""))].sort();
}

/** What to call the thing being chosen, for the message that refuses a choice. */
export interface Terms {
  one: string;
  many: string;
}

/**
 * The one of `names` a report can be fitted on. A file that carries several would pool them,
 * so it is refused by name; a name the file does not carry is refused outright, because an
 * empty report would read as "no data yet". `flag` is the one that picks.
 */
export function chooseOne(
  names: string[],
  requested: string | undefined,
  terms: Terms,
  flag: string,
): { name: string } | { error: string } {
  if (requested !== undefined) {
    if (names.length > 0 && !names.includes(requested)) {
      return { error: `no ${terms.one} "${requested}" (has: ${names.join(", ")})` };
    }
    return { name: requested };
  }
  if (names.length > 1) {
    return { error: `${names.length} ${terms.many} (${names.join(", ")}); pass ${flag} <name>` };
  }
  return { name: names[0] ?? "" };
}

const DEFAULT_LOG = join(homedir(), ".pi", "agent", "state", "policy-guard.log");

export const CLI: CliSpec = {
  name: "calibrate.ts",
  summary: "Fit a per-clause threshold from the decision log or a benchmark dump.",
  args: "[path]",
  arity: { min: 0, max: 1 },
  flags: [
    {
      key: "bench",
      type: "boolean",
      short: "b",
      synopsis: "[--bench]",
      usage: "-b, --bench",
      help: "Read a benchmark dump written by benchmarks/policy.ts instead of the decision log.",
    },
    {
      key: "policy",
      type: "string",
      synopsis: "[--policy <name>]",
      usage: "--policy <name>",
      help: "The policy run to read from a dump, needed when the dump carries several.",
    },
    {
      key: "project",
      type: "string",
      synopsis: "[--project <name>]",
      usage: "--project <name>",
      help: "The project whose records to fit, needed when the log carries several.",
    },
    { key: "help", type: "boolean", short: "h", global: true, usage: "-h, --help", help: "this help" },
  ],
};

/** What a parsed argv means: which source, scoped to one project or policy, from which file. */
export interface CliInput {
  bench: boolean;
  policy?: string;
  project?: string;
  path: string;
}

/** The parsed flags and path to read. `args` never holds a flag's value, so the first is the path. */
export function cliInput(parsed: ParsedCli, defaultPath: string = DEFAULT_LOG): CliInput {
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  return {
    bench: parsed.values.bench === true,
    policy: text(parsed.values.policy),
    project: text(parsed.values.project),
    path: parsed.args[0] ?? defaultPath,
  };
}

if (import.meta.main) {
  // Loaded here, not at the top: a module this tree also imports as a library should not pay
  // for a parser it uses only when run, and this path resolves from the repo where it is run.
  const { scriptCli } = await import("../../../../shared/cli");
  const input = cliInput(scriptCli(CLI));

  let raw = "";
  try {
    raw = readFileSync(input.path, "utf-8");
  } catch {
    console.error(`no file at ${input.path}`);
    process.exit(1);
  }

  if (input.bench) {
    const { rows, policies } = readBenchDump(raw, input.policy);
    const chosen = chooseOne(policies, input.policy, { one: "policy", many: "policies" }, "--policy");
    if ("error" in chosen) {
      console.error(chosen.error);
      process.exit(1);
    }
    if (rows.length === 0) {
      console.error(
        `no policy rows for ${chosen.name || "any policy"} in ${input.path} (has: ${policies.join(", ") || "none"})`,
      );
      process.exit(1);
    }
    console.log(benchReport(rows, input.path, chosen.name).lines.join("\n"));
    console.log(`\n${benchReport(rows, input.path, chosen.name).footer}`);
    process.exit(0);
  }

  const decisions = parseDecisions(raw);
  const projects = projectsIn(decisions);
  const chosen = chooseOne(projects, input.project, { one: "project", many: "projects" }, "--project");
  if ("error" in chosen) {
    console.error(chosen.error);
    process.exit(1);
  }
  const report = logReport(decisions, chosen.name, input.path);
  console.log(report.lines.join("\n"));
  console.log(`\n${report.footer}`);
}
