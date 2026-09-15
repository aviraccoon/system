/**
 * Edit-guard rule config: which files carry content rules agents must follow,
 * and what line patterns violate them.
 *
 * Rules are DATA, not code. The table below ships as built-in defaults; a
 * user config (~/.config/llm/edit-guard.json, same shape) replaces it
 * entirely when present. Replace, not merge — merge semantics for "which
 * patterns apply" are ambiguity the agent never needs to see.
 *
 * Only rules with observed violations belong in the table — a speculative row
 * costs false positives on every edit of the matched files. Each default row
 * earned its place by repeated agent violations of a written rule despite
 * prompt instructions. Adding a row is the whole extension point.
 */

import { basename } from "node:path";

/** Directories the agent runs in whose files are exempt from some rules. */
export interface RuntimeRoots {
  cwd: string;
  /** Journal notes root (from ~/.config/llm/journal.json). */
  notesDir: string;
  /** pi session logs. */
  sessionsDir: string;
}

/** Serializable rule table — this is what the JSON config holds. */
export interface RuleConfig {
  /** Name used in message headers. */
  displayName: string;
  match:
    | { kind: "basename"; names: string[] }
    | {
        /** Absolute paths with {notesDir}, {sessionsDir}, {cwd} placeholders. */
        kind: "allExcept";
        paths: string[];
      };
  /**
   * Self-contained policy statement quoted verbatim in every violation
   * message — the agent reading the tool result gets the rule and the
   * corrective action without needing session memory.
   */
  policy: string;
  /** flags is standard RegExp flags ("i" for case-insensitive). */
  patterns: { label: string; regex: string; flags?: string }[];
}

export const DEFAULT_RULE_CONFIG: RuleConfig[] = [
  {
    displayName: "TODO.md",
    match: { kind: "basename", names: ["todo.md"] },
    policy:
      "TODO.md lists only unfinished, actionable work. DELETE done items entirely — the journal holds the details. " +
      "Never reword a done item, annotate it as done, or leave a pointer to it. " +
      "If a flagged line is genuinely still-open work, leave it untouched.",
    patterns: [
      { label: "checked checkbox", regex: "^\\s*(?:[-*+]|\\d+[.)])?\\s*\\[[xX]\\]" },
      { label: "Markdown checkbox (TODO uses plain '- item')", regex: "^\\s*(?:[-*+]|\\d+[.)])?\\s*\\[\\s?\\]" },
      // Case-sensitive on purpose: lowercase "done" is common in legitimate
      // prose ("the rest would be done in the next pass").
      { label: "DONE marker", regex: "\\bDONE\\b" },
      { label: "RESOLVED marker", regex: "\\bRESOLVED\\b" },
      { label: "strikethrough", regex: "~~" },
      { label: "checkmark", regex: "[\u2705\u2611\u2713]" },
      { label: "done tag", regex: "\\[(?:done|completed)\\]|\\((?:done|completed)\\)", flags: "i" },
    ],
  },
  {
    displayName: "public file",
    match: {
      kind: "allExcept",
      // Private agent trees where references to journals and sessions are
      // legitimate: the notes root, session logs, the repo's agent-config
      // tree, and project-local agent dirs.
      paths: ["{notesDir}", "{sessionsDir}", "{cwd}/config/llm", "{cwd}/.pi"],
    },
    policy:
      "Public files (code, comments, docs, configs) must be self-contained — no references to private journals, " +
      "session logs, internal plans or codenames, or anything else a repo reader cannot see. Describe the work on " +
      "its own terms. If the flagged reference points at an in-repo document or is otherwise intentional and " +
      "public-safe, ignore it.",
    patterns: [
      { label: "journal path reference", regex: "\\bnotes/llm\\b" },
      {
        label: "journal entry filename reference",
        regex: "\\b\\d{4}-\\d{2}-\\d{2}-\\d{2}-[a-z0-9][a-z0-9-]*\\.md\\b",
      },
      { label: "session log path reference", regex: "\\.pi/agent/sessions" },
    ],
  },
  {
    // Comments referencing "the plan" assume a reader who has the internal
    // planning doc — observed violation in public code. Codenames beyond this
    // are user-maintained: add patterns via ~/.config/llm/edit-guard.json.
    displayName: "internal codename",
    match: {
      kind: "allExcept",
      paths: ["{notesDir}", "{sessionsDir}", "{cwd}/config/llm", "{cwd}/.pi"],
    },
    policy:
      "Comments and docs must describe the change on their own terms — no references to internal plans, codenames, " +
      "or other private artifacts a repo reader cannot see.",
    patterns: [{ label: "internal plan reference", regex: "\\bthe plan\\b", flags: "i" }],
  },
];

// ── Config loading: validate + merge user config over defaults ──

/**
 * Merge custom entries over defaults, keyed by displayName: a custom entry
 * replaces the default with the same displayName (in place); others append.
 * The displayName doubles as the rule's identity — it appears in every
 * message header, so duplicate names would be indistinguishable to the agent.
 */
export function mergeRuleConfigs(defaults: RuleConfig[], custom: RuleConfig[]): RuleConfig[] {
  const merged = [...defaults];
  for (const entry of custom) {
    const index = merged.findIndex((r) => r.displayName === entry.displayName);
    if (index >= 0) merged[index] = entry;
    else merged.push(entry);
  }
  return merged;
}

/** Null when valid; otherwise a self-contained error naming the problem. */
export function validateRuleConfig(entry: unknown, source: string): string | null {
  const where = (problem: string) => `edit-guard rule in ${source}: ${problem}`;
  if (typeof entry !== "object" || entry === null) return where("entry must be an object");
  const r = entry as Record<string, unknown>;
  if (typeof r.displayName !== "string" || r.displayName.length === 0)
    return where(`"displayName" must be a non-empty string (got ${JSON.stringify(r.displayName)})`);
  if (typeof r.policy !== "string" || r.policy.length === 0)
    return where(`"${r.displayName}": "policy" must be a non-empty string`);
  const match = r.match as Record<string, unknown> | undefined;
  if (typeof match !== "object" || match === null)
    return where(`"${r.displayName}": "match" must be { kind: "basename" | "allExcept", ... }`);
  if (match.kind === "basename") {
    if (!Array.isArray(match.names) || match.names.some((n) => typeof n !== "string"))
      return where(`"${r.displayName}": basename match needs "names": [string, ...]`);
  } else if (match.kind === "allExcept") {
    if (!Array.isArray(match.paths) || match.paths.some((p) => typeof p !== "string"))
      return where(`"${r.displayName}": allExcept match needs "paths": [string, ...]`);
  } else {
    return where(`"${r.displayName}": match.kind must be "basename" or "allExcept"`);
  }
  if (!Array.isArray(r.patterns) || r.patterns.length === 0)
    return where(`"${r.displayName}": "patterns" must be a non-empty array`);
  for (const p of r.patterns as Record<string, unknown>[]) {
    if (typeof p.label !== "string" || typeof p.regex !== "string")
      return where(`"${r.displayName}": every pattern needs string "label" and "regex"`);
    if (p.flags !== undefined && typeof p.flags !== "string")
      return where(`"${r.displayName}": pattern "${p.label}": "flags" must be a string`);
  }
  return null;
}

// ── Compilation: config data → matchers with real RegExp objects ──

export interface ContentRule {
  /** Short label shown in violation messages (e.g. "DONE marker"). */
  label: string;
  /** Tested against each line of the post-edit content. No /g flag. */
  pattern: RegExp;
}

export interface CompiledPathRule {
  displayName: string;
  matches: (absPath: string, roots: RuntimeRoots) => boolean;
  policy: string;
  rules: ContentRule[];
}

export interface CompileResult {
  rules: CompiledPathRule[];
  /**
   * Self-contained messages for patterns that failed to compile. A broken
   * pattern must be loud: silently never matching is the exact "no errors"
   * lie this extension exists to prevent. Failed patterns are skipped.
   */
  errors: string[];
}

function under(dir: string, abs: string): boolean {
  return abs === dir || abs.startsWith(`${dir}/`);
}

function expandPlaceholders(path: string, roots: RuntimeRoots): string {
  return path
    .replaceAll("{notesDir}", roots.notesDir)
    .replaceAll("{sessionsDir}", roots.sessionsDir)
    .replaceAll("{cwd}", roots.cwd);
}

export function compileRules(config: RuleConfig[]): CompileResult {
  const errors: string[] = [];
  const rules: CompiledPathRule[] = [];

  for (const entry of config) {
    const contentRules: ContentRule[] = [];
    for (const p of entry.patterns) {
      try {
        contentRules.push({ label: p.label, pattern: new RegExp(p.regex, p.flags) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(
          `edit-guard rule "${entry.displayName}": pattern "${p.regex}" (label "${p.label}") failed to compile: ${msg}. Fix or remove it in the config.`,
        );
      }
    }

    if (entry.match.kind === "basename") {
      const names = new Set(entry.match.names.map((n) => n.toLowerCase()));
      rules.push({
        displayName: entry.displayName,
        policy: entry.policy,
        matches: (abs) => names.has(basename(abs).toLowerCase()),
        rules: contentRules,
      });
    } else {
      const excludePaths = entry.match.paths;
      rules.push({
        displayName: entry.displayName,
        policy: entry.policy,
        matches: (abs, roots) => {
          const excluded = excludePaths.some((raw) => under(expandPlaceholders(raw, roots), abs));
          return !excluded;
        },
        rules: contentRules,
      });
    }
  }

  return { rules, errors };
}
