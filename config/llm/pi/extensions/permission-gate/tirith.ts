/**
 * tirith integration — optional deterministic command-safety net for the bash path.
 *
 * Composes tirith (structural + threat-DB checks: homograph URLs, pipe-to-shell,
 * base64-decode-execute, credential exfiltration, known-bad packages) into the
 * permission gate. tirith inspects the FULL command — the gate's allow path is
 * prefix-blind (an allowed "curl"/"npm" prefix doesn't see the URL or package
 * name), so tirith catches what prefix matching and the sidecar classifier miss.
 *
 * Scope: bash only, on every bash call. It can only change the outcome when the
 * gate would otherwise ALLOW (the blind spot) — there the verdict is enforced.
 * On a path the gate already confirms, the verdict is surfaced in the dialog so
 * the human decides informed rather than enforced on top.
 *
 * Graceful degradation:
 *  - tirith not on PATH (other machines, uninstalled) → no-op, gate unchanged.
 *  - tirith error/timeout → fail-open-to-gate (the confirm flow is a backstop).
 *
 * Hot-path env: TIRITH_LOG=0 only (pi already logs tool calls; avoid duplicating
 * every agent bash command into tirith's audit log). Deliberately NOT offline:
 * tirith's periodic background DB refresh (24h, non-blocking) keeps the threat-DB
 * current, and since tirith is used exclusively through these checks (no shell
 * hook), going offline would let the DB go stale. The refresh is detached, so it
 * doesn't slow the check. `check`'s package detection is local-DB-only either
 * way (live registry signals need `tirith package risk --online`, a separate
 * on-demand tool); the confirm dialog covers package review.
 */
import { execFile } from "node:child_process";

const TIRITH_TIMEOUT_MS = 10_000;

export interface TirithFinding {
  severity: string;
  ruleId: string;
  title: string;
  description: string;
}

export type TirithVerdict =
  | { action: "pass" }
  | { action: "block"; reason: string; findings: TirithFinding[] }
  | { action: "warn"; findings: TirithFinding[] };

interface TirithJson {
  action?: string; // "allow" | "warn" | "block" (schema v3)
  findings?: Array<{ severity?: string; rule_id?: string; title?: string; description?: string }>;
}

/**
 * Rules whose finding means "could not prove this is safe" rather than "this is
 * unsafe". tirith's tier-3 analyzer cannot resolve some ordinary static POSIX —
 * `if [ … ]; then …; fi`, `while [ … ]`, and `$(…)` inside `$(( ))` — and
 * reports `analysis_incomplete` at HIGH (upstream issue #260). A coverage gap is
 * not a detection: honouring it as a block makes the gate reject shell whose
 * body is fully visible in the source.
 *
 * Downgraded only when EVERY finding is a coverage gap. A real detection
 * alongside one keeps the block — "could not prove it" plus "here is a concrete
 * problem" still means stop.
 */
const COVERAGE_GAP_RULES = new Set(["analysis_incomplete"]);

/**
 * Pure: map a parsed tirith JSON result to a gate verdict. Exported for tests.
 * Prefers the top-level `action` field (schema v3); falls back to exit codes
 * (0 allow, 1 block, 2 warn) only if JSON is missing or lacks an action.
 */
export function mapTirithResult(parsed: TirithJson | null, exitCode: number): TirithVerdict {
  if (parsed?.action) {
    const findings: TirithFinding[] = (parsed.findings ?? []).map((f) => ({
      severity: f.severity ?? "UNKNOWN",
      ruleId: f.rule_id ?? "unknown",
      title: f.title ?? "",
      description: f.description ?? "",
    }));
    if (parsed.action === "block") {
      if (findings.length > 0 && findings.every((f) => COVERAGE_GAP_RULES.has(f.ruleId))) {
        return { action: "warn", findings };
      }
      return { action: "block", reason: formatBlockReason(findings), findings };
    }
    if (parsed.action === "warn") return { action: "warn", findings };
    return { action: "pass" };
  }
  if (exitCode === 1) return { action: "block", reason: "tirith: blocked (no detail)", findings: [] };
  if (exitCode === 2) return { action: "warn", findings: [] };
  return { action: "pass" };
}

export function formatBlockReason(findings: TirithFinding[]): string {
  if (findings.length === 0) return "Blocked by tirith (command-structure check)";
  const rules = findings.map((f) => `[${f.severity}] ${f.ruleId}: ${f.title}`).join("; ");
  // The first finding's description usually carries a "Safer: ..." remediation.
  const remedy = findings[0].description ? `\n${findings[0].description}` : "";
  return `tirith ${rules}${remedy}`;
}

export function formatFindingSummary(findings: TirithFinding[]): string {
  return findings.map((f) => `[${f.severity}] ${f.ruleId}: ${f.title}`).join("; ");
}

/**
 * Self-explanatory tirith annotation for LLM consumption. The LLM has no prior
 * context for what tirith is, so this spells it out: names tirith as a
 * command-safety checker, gives severity + rule + title + the remediation.
 */
export function tirithAnnotation(action: "block" | "warn", findings: TirithFinding[]): string {
  if (findings.length === 0) return "";
  const top = findings[0];
  const label = action === "block" ? "dangerous" : "potentially unsafe";
  const desc = top.description ? ` ${top.description}` : "";
  return `[tirith (a command-safety checker) flagged this command as ${label} — ${top.severity} ${top.ruleId}: ${top.title}.${desc}]`;
}

/** Detect tirith once (session start). Returns false if not on PATH or broken. */
export function detectTirith(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("tirith", ["--version"], { timeout: 2000 }, (err, stdout) => {
      resolve(!err && /tirith\s+\d/i.test(stdout));
    });
  });
}

/**
 * Check a command with tirith. Never throws — errors/timeout → pass (fail-open).
 * Uses the no-log hot-path profile (see module doc).
 */
export function checkCommand(command: string): Promise<TirithVerdict> {
  return new Promise((resolve) => {
    // TIRITH_LOG=0 — pi already logs tool calls; avoid duplicating into tirith's log.
    // See module doc for why this is NOT offline (DB freshness).
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
            resolve(mapTirithResult(safeParse(stdout), code));
            return;
          }
          // ENOENT (uninstalled mid-session), timeout, or spawn error → fail-open.
          resolve({ action: "pass" });
          return;
        }
        resolve(mapTirithResult(safeParse(stdout), 0));
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
