/**
 * tirith integration — an external command-safety checker, used as a witness.
 *
 * tirith inspects a full command for things the factor battery cannot see: a package,
 * host or URL on a curated threat list, hidden or confusable text, a disabled certificate
 * or signature check. Its findings do not decide anything here. They are handed to the classifier as
 * evidence, in words a model can weigh, because tirith's own tiers cannot be reused as
 * policy: one rule id covers both an attack and an ordinary shape, the catalogue exposes
 * no per-rule action, and the action it does report follows tirith's own config. Trying
 * to split the good shapes from the bad ones meant maintaining a rule list that went
 * stale on every release.
 *
 * One exception, because a model should not be asked: a finding tirith rates CRITICAL — a
 * confirmed malware row, a bidi or Unicode-tag concealment — holds the decision, never
 * the classifier's, as does a block that carries no finding or no severity.
 *
 * Scope: bash only, every bash call. Graceful degradation: tirith missing → no findings;
 * error or timeout → no findings (the confirm flow is the backstop).
 *
 * Hot-path env: TIRITH_LOG=0 only (pi already logs tool calls; avoid duplicating every
 * agent bash command into tirith's audit log). Deliberately NOT offline: tirith's 24h
 * background DB refresh is what keeps the threat lists current, and nothing else runs
 * tirith. The refresh is detached, so it does not slow the check. `check`'s package
 * detection is local-DB-only either way; live registry signals need
 * `tirith package risk --online`, a separate on-demand tool.
 */
import { execFile } from "node:child_process";

const TIRITH_TIMEOUT_MS = 10_000;

export interface TirithFinding {
  severity: string;
  ruleId: string;
  title: string;
  description: string;
}

export interface TirithReport {
  action: "pass" | "warn" | "block";
  findings: TirithFinding[];
}

interface TirithJson {
  action?: string; // "allow" | "warn" | "block" (schema v3)
  findings?: Array<{ severity?: string; rule_id?: string; title?: string; description?: string }>;
}

/**
 * Pure: turn tirith's JSON (or a bare exit code) into a report. Prefers the `action`
 * field; falls back to the exit codes (0 allow, 1 block, 2 warn) only when JSON is
 * missing or lacks one.
 */
export function parseTirith(parsed: TirithJson | null, exitCode: number): TirithReport {
  const findings: TirithFinding[] = (parsed?.findings ?? []).map((f) => ({
    severity: f.severity ?? "UNKNOWN",
    ruleId: f.rule_id ?? "unknown",
    title: f.title ?? "",
    description: f.description ?? "",
  }));
  if (parsed?.action === "block") return { action: "block", findings };
  if (parsed?.action === "warn") return { action: "warn", findings };
  if (parsed?.action === "allow") return { action: "pass", findings };
  // No action, or one this build does not know (a renamed tier): the exit code decides.
  if (exitCode === 1) return { action: "block", findings };
  if (exitCode === 2) return { action: "warn", findings };
  return { action: "pass", findings };
}

/**
 * Whether this report refuses the call instead of being weighed: a CRITICAL finding, or
 * a block carrying no finding or no severity to read (nothing to judge, so fail closed).
 * Everything else reaches the classifier as evidence.
 */
export function tirithFloor(report: TirithReport): boolean {
  // Severity alone decides: the action a report carries follows tirith's config, and a
  // CRITICAL finding is the one class no dialog helps a user weigh.
  if (report.findings.some((finding) => finding.severity.toUpperCase() === "CRITICAL")) return true;
  // A block carrying nothing judgeable — no rule, or no severity to read — fails closed.
  const unrated = report.findings.some((finding) => finding.severity.toUpperCase() === "UNKNOWN");
  return report.action === "block" && (report.findings.length === 0 || unrated);
}

/** The evidence a classifier reads. It says what tirith is, because the model has no
 *  prior context for it, then gives each finding's severity, rule and description. */
export function tirithFact(report: TirithReport): string {
  if (report.findings.length === 0) return "";
  const rows = report.findings.map((finding) => {
    const detail = finding.description ? ` ${finding.description}` : "";
    return `[${finding.severity}] ${finding.ruleId} — ${finding.title}.${detail}`;
  });
  return [
    "tirith (an external command-safety checker; it looks up the packages, hosts and text the command carries against curated threat lists and encoding checks) reports:",
    ...rows,
  ].join("\n");
}

/** Dialog banner text: the rules and their severities. */
export function formatFindingSummary(report: TirithReport): string {
  return report.findings.map((finding) => `[${finding.severity}] ${finding.ruleId}: ${finding.title}`).join("; ");
}

/** Detect tirith once (session start). Returns false if not on PATH or broken. */
export function detectTirith(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tirith", ["--version"], { timeout: 2000 }, (err, stdout) => {
      resolve(!err && /tirith\s+\d/i.test(stdout));
    });
  });
}

/** Check a command with tirith. Never throws — errors/timeout → a pass (fail-open). */
export function checkCommand(command: string): Promise<TirithReport> {
  return new Promise((resolve) => {
    const env = { ...process.env, TIRITH_LOG: "0" };
    execFile(
      "tirith",
      ["check", "--format", "json", "--no-daemon", "--non-interactive", "--", command],
      { timeout: TIRITH_TIMEOUT_MS, env, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          const code = (err as { code?: unknown }).code;
          // Non-zero exit (tirith block/warn): stdout still carries the JSON.
          if (typeof code === "number") {
            resolve(parseTirith(safeParse(stdout), code));
            return;
          }
          // ENOENT (uninstalled mid-session), timeout, or spawn error → no findings.
          resolve({ action: "pass", findings: [] });
          return;
        }
        resolve(parseTirith(safeParse(stdout), 0));
      },
    );
  });
}

function safeParse(s: string): TirithJson | null {
  try {
    return s ? (JSON.parse(s) as TirithJson) : null;
  } catch {
    return null;
  }
}
