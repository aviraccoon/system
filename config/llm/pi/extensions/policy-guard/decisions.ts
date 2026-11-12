/**
 * The guard's decision record: one line per judged call or unlock, and the view of it the
 * agent gets.
 *
 * Two readers, one writer. The file keeps the probability and which session it
 * came from, because that is what calibrating the threshold needs. The tool view
 * drops the probability and keeps the clause: a score in front of the agent is one
 * to binary-search. It is the view's rule, not a containment claim: an uncited
 * refusal already quotes its probability in the reason line.
 *
 * No pi imports. Tests run under bun.
 */

/** Which rule did the refusing: the judge, the floor on the policy file, or a user unlock. */
export type DecisionKind = "policy" | "policy-write" | "policy-shell" | "unlock";

export interface GuardDecision {
  at: string;
  /** Session the call happened in, so a reader can scope to one session. */
  session: string;
  project: string;
  kind: DecisionKind;
  /** First line of the command, clipped: enough to recognize it, not a log of it. */
  command: string;
  /**
   * The tool the call used. On an unlock, the surface it unlocks: a tool name, or `*` for
   * every surface. Empty on a record that predates it.
   */
  tool: string;
  violated: boolean;
  /** The clause the refusal cited, or null when it cited none. */
  clause: string | null;
  /** The judge's probability. File only: the agent's view never shows it. */
  probability: number | null;
  threshold: number;
  /**
   * Every answered clause's probability for this call, which is what a per-clause threshold is
   * calibrated from. An unanswered clause is absent, and named in `missing`. Absent in records
   * written before it was recorded.
   */
  scores: Record<string, number>;
  /** Clause ids the judge did not answer, so they were not checked. */
  missing: string[];
}

/** How much of a command a decision keeps. */
export const COMMAND_LIMIT = 80;

/** Decisions a session view shows, newest last. */
export const VIEW_LIMIT = 20;

/** Lines the file keeps; trimmed to this many at session start. */
export const FILE_LIMIT = 2000;

/** The first line of a command, clipped, so one record stays one record. */
export function commandLine(command: string, limit: number = COMMAND_LIMIT): string {
  const line = command.split("\n")[0]?.trim() ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A record's per-clause scores, tolerant of an older line that carries none. */
function scoresAt(value: unknown): Record<string, number> {
  const raw = typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const [key, score] of Object.entries(raw)) {
    if (typeof score === "number" && Number.isFinite(score)) out[key] = score;
  }
  return out;
}

/** One record as a JSON line. */
export function formatDecision(decision: GuardDecision): string {
  return `${JSON.stringify(decision)}\n`;
}

/**
 * Records from a log file, skipping anything that is not a complete record: a
 * truncated last line is what a killed process leaves, and it must not decide the
 * view.
 */
export function parseDecisions(raw: string): GuardDecision[] {
  const out: GuardDecision[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const record = value as Partial<GuardDecision> | null;
    if (!record || typeof record !== "object") continue;
    if (typeof record.at !== "string" || typeof record.session !== "string") continue;
    if (typeof record.kind !== "string" || typeof record.command !== "string") continue;
    if (typeof record.violated !== "boolean") continue;
    const rawMissing = (record as { missing?: unknown }).missing;
    out.push({
      at: record.at,
      session: record.session,
      project: typeof record.project === "string" ? record.project : "",
      kind: record.kind as DecisionKind,
      command: record.command,
      tool: typeof record.tool === "string" ? record.tool : "",
      violated: record.violated,
      clause: typeof record.clause === "string" ? record.clause : null,
      probability: typeof record.probability === "number" ? record.probability : null,
      threshold: typeof record.threshold === "number" ? record.threshold : 0,
      scores: scoresAt((record as { scores?: unknown }).scores),
      missing: Array.isArray(rawMissing) ? rawMissing.filter((id): id is string => typeof id === "string") : [],
    });
  }
  return out;
}

/** What a refusal's reason was, in the words the record uses. */
function kindLabel(kind: DecisionKind): string {
  if (kind === "policy-write") return "refused (policy file write)";
  if (kind === "policy-shell") return "refused (policy file named in shell)";
  return "refused";
}

/**
 * The tail of a log, `keep` lines at most. A file that is only appended to grows
 * with every judged command, so the trim keeps the end: a view only ever shows the
 * newest records, and an old one can be dropped.
 */
export function trimLines(raw: string, keep: number): string {
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  if (lines.length <= keep) return raw;
  return `${lines.slice(-keep).join("\n")}\n`;
}

/**
 * The agent-facing view: this session's decisions, newest last, no probabilities.
 * An allowed call is shown too, because "it ran" is not the same as "the judge
 * cleared it" and only the record can say which.
 */
export function sessionView(decisions: GuardDecision[], sessionId: string, limit: number = VIEW_LIMIT): string[] {
  const mine = decisions.filter((decision) => decision.session === sessionId);
  const shown = mine.slice(-limit);
  return shown.map((decision) => {
    // An unlock is the user's own decision, recorded as a label: it refused nothing.
    if (decision.kind === "unlock") return `- unlock  ${decision.command}`;
    const what = decision.violated ? kindLabel(decision.kind) : "allowed";
    const why = decision.violated ? ` -> ${decision.clause ?? "no clause cited"}` : "";
    return `- ${what}  ${decision.command}${why}`;
  });
}
