/**
 * Pure decision logic for the permission gate.
 * No pi imports — testable independently.
 */

import { execSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";

// ── Types ──

export type Mode = "careful" | "trust-project" | "allow-all";

export type AutoClassifyMode = "off" | "on";

export type ToolAction = "allow" | "confirm" | "block";

export interface AutoClassifyLog {
  toolName: string;
  description: string;
  verdict: string;
  short: string;
  timestamp: number;
}

export interface GateState {
  mode: Mode;
  autoClassify: AutoClassifyMode;
  gitRoot: string | null;
  allowedBashPrefixes: string[];
  allowedPaths: string[];
  allowedPathGlobs: string[];
  toolOverrides: Partial<Record<string, "allow" | "confirm">>;
  /** Exact-match cache: hash of (toolName + full input) -> full explanation result */
  classifyCache: Map<string, { verdict: "safe" | "risky" | "dangerous"; short: string; detail: string }>;
  /** Audit log of auto-allowed calls */
  autoAllowLog: AutoClassifyLog[];
}

export interface GateDecision {
  action: ToolAction;
  reason?: string;
  /** For confirm: what kind of confirmation UI to show */
  confirmType?: "write" | "sensitive" | "bash" | "outside-project";
  /** Display path for UI */
  displayPath?: string;
  /** Suggested bash prefix for the session-allow option */
  suggestedPrefix?: string;
  /** True when a bash command matched a session prefix but was blocked by escalation detection. */
  escalation?: boolean;
}

// ── Constants ──

export const MODE_LABELS: Record<Mode, string> = {
  careful: "\u{1f512} Careful",
  "trust-project": "\u{1f4c1} Trust project",
  "allow-all": "\u{26a1} Allow all",
};

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
  careful: "Reads allowed everywhere. All writes, edits, and bash confirmed.",
  "trust-project":
    "Writes/edits in project allowed. Bash in project allowed. Sensitive files and outside-project always confirmed.",
  "allow-all": "Everything allowed without confirmation.",
};

export const MODE_SHORT: Record<Mode, string> = {
  careful: "confirms all writes, edits, and bash",
  "trust-project": "allows writes + bash in project, confirms outside + sensitive",
  "allow-all": "no confirmations",
};

export const MODE_CYCLE: Mode[] = ["careful", "trust-project", "allow-all"];

/** Tools that mutate nothing in this session and delegate the work to a child
 *  whose own gate decides what it may do (subagent). Confirming them buys no
 *  safety and costs one dialog per delegation. */
export const DELEGATION_TOOLS = ["subagent"];

/** Tools that only read. `web_fetch` is a network read with no local side
 *  effect; its one blind spot (data smuggled in a URL) is accepted here the
 *  same way Claude Code accepts it for WebFetch. */
export const READ_ONLY_TOOLS = ["read", "ls", "grep", "find", "web_search", "web_fetch"];

export const SENSITIVE_PATTERNS: RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.cert$/,
  /\.keystore$/,
  /(^|\/)secrets\//,
  /secret/i,
  /(^|\/)\.ssh\//,
  /(^|\/)\.gnupg\//,
  /(^|\/)id_rsa/,
  /(^|\/)id_ed25519/,
];

// ── Pure functions ──

export function isInsideDir(filePath: string, dir: string): boolean {
  const rel = relative(dir, filePath);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export function isSensitivePath(filePath: string): boolean {
  const parts = filePath.split("/");
  const basename = parts[parts.length - 1];
  return SENSITIVE_PATTERNS.some((p) => p.test(basename) || p.test(filePath));
}

/** Strip leading cd/pushd and shell operators to find the real command.
 *  Handles quoted arguments (paths with spaces). */
export function stripShellPreamble(command: string): string {
  let cmd = command.trim();

  while (true) {
    const match = cmd.match(/^\s*(cd|pushd)\s+/);
    if (!match) break;

    let pos = match[0].length;

    // Skip the argument, respecting quotes
    const ch = cmd[pos];
    if (ch === '"' || ch === "'") {
      const close = cmd.indexOf(ch, pos + 1);
      if (close === -1) break; // unclosed quote, bail
      pos = close + 1;
    } else {
      // Unquoted: advance to next whitespace or shell metachar
      while (pos < cmd.length && !/[\s;&|]/.test(cmd[pos])) pos++;
    }

    // Skip whitespace between arg and separator
    while (pos < cmd.length && /\s/.test(cmd[pos])) pos++;

    // Expect && or || or ;
    const rest = cmd.slice(pos);
    const sepMatch = rest.match(/^(&&|\|\||;)\s*/);
    if (!sepMatch) break;

    cmd = rest.slice(sepMatch[0].length);
  }

  return cmd.trim();
}

/** Extract a session-allow prefix: the command name (first token) after stripping preamble. */
export function suggestPrefix(command: string): string {
  const real = stripShellPreamble(command);
  const tokens = real.split(/\s+/);
  return tokens[0];
}

/** Read-only commands safe to pipe to. These can't escalate a simple command. */
const SAFE_PIPE_TARGETS = new Set([
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "grep",
  "rg",
  "awk",
  "sed", // sed without -i is read-only in a pipe
  "cut",
  "tr",
  "less",
  "more",
  "cat",
  "column",
  "fmt",
  "nl",
  "rev",
  "tac",
  "fold",
  "paste",
  "expand",
  "unexpand",
  "jq",
  "yq",
  "bat",
  "fzf",
]);

/**
 * Check if all pipe targets in a command are safe read-only filters.
 * Returns true if every command after a `|` starts with a known safe command.
 * Operates on the quote-stripped version of the command.
 */
function allPipesSafe(unquoted: string): boolean {
  const segments = unquoted.split(/\|/);
  if (segments.length <= 1) return true;
  for (const seg of segments.slice(1)) {
    const cmd = seg.trim().split(/\s+/)[0];
    if (!cmd || !SAFE_PIPE_TARGETS.has(cmd)) return false;
  }
  return true;
}

/**
 * Detect shell patterns that could escalate a simple command into something dangerous.
 * Pipes to safe filters (head, tail, grep, jq, etc.) are allowed.
 * Chains, subshells, redirects, and find -exec/-delete are flagged.
 *
 * Checked at match time: a prefix like "rg" auto-allows `rg -n foo`
 * and `rg foo | head -5`, but still confirms `rg foo | xargs rm`.
 *
 * False positives (e.g. `grep -E "a|b"`) just mean one extra confirmation.
 */
export function hasShellEscalation(command: string): boolean {
  // Strip quoted strings to avoid false positives from patterns inside quotes.
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/'[^']*'/g, "");

  // Semicolons, chains, subshells, backticks (always escalation)
  if (/;|&&|\$\(|`/.test(unquoted)) return true;

  // Pipes: only escalation if piping to an unsafe command
  if (/\|/.test(unquoted) && !allPipesSafe(unquoted)) return true;

  // Output redirects (but not fd duplication like 2>&1)
  if (/(?<![0-9&])>[^&]/.test(unquoted) || />>/.test(unquoted)) return true;

  // find -exec, -execdir, -delete
  const tokens = unquoted.split(/\s+/);
  if (tokens[0] === "find" && tokens.some((t) => t === "-exec" || t === "-execdir" || t === "-delete")) {
    return true;
  }

  return false;
}

/** Resolve a file path, stripping leading @ that some models add. */
export function resolveFilePath(path: string, cwd: string): string {
  const cleaned = path.startsWith("@") ? path.slice(1) : path;
  return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

/** Resolve all file paths a mutating tool targets to absolute paths. patch
 * may carry per-edit paths (multi-file) overriding the top-level path. */
export function collectTargetPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
  return collectToolPaths(toolName, input).map((p) => resolveFilePath(p, cwd));
}

/** Match a path against a glob pattern. Supports * and **. */
export function matchGlob(path: string, pattern: string): boolean {
  // Split on ** first to handle it separately
  const parts = pattern.split("**");

  let re = "";
  for (let i = 0; i < parts.length; i++) {
    // Escape and convert single * and ? in each part
    const part = parts[i]
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    re += part;

    // Insert ** replacement between parts
    if (i < parts.length - 1) {
      const next = parts[i + 1];
      if (next.startsWith("/")) {
        // **/ matches zero or more directory segments
        // Make the slash and any dirs optional so ** alone matches at root
        parts[i + 1] = next.slice(1);
        re += "(.*/)?";
      } else {
        re += ".*";
      }
    }
  }

  return new RegExp(`^${re}$`).test(path);
}

/** Check if a path matches any allowed path (exact or prefix) or glob. */
export function isPathAllowed(filePath: string, cwd: string, state: GateState): boolean {
  // Exact / prefix match
  if (
    state.allowedPaths.some((p) => {
      const resolved = resolve(cwd, p);
      return filePath === resolved || filePath.startsWith(resolved);
    })
  ) {
    return true;
  }

  // Glob match (against relative path from project root)
  const projectRoot = state.gitRoot ?? cwd;
  const rel = relative(projectRoot, filePath);
  if (state.allowedPathGlobs.some((glob) => matchGlob(rel, glob))) {
    return true;
  }

  return false;
}

/** Check if a bash command matches any allowed prefix.
 *  Compound/piped commands are never auto-allowed, even if the prefix matches. */
export function isBashAllowed(command: string, state: GateState): boolean {
  const real = stripShellPreamble(command);
  if (hasShellEscalation(real)) return false;
  return state.allowedBashPrefixes.some((prefix) => real.startsWith(prefix));
}

/** Resolve git root, following worktrees back to the main repo. */
export function findGitRoot(cwd: string): string | null {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    try {
      const commonDir = execSync("git rev-parse --git-common-dir", {
        cwd: root,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (commonDir.endsWith("/.git")) {
        return resolve(commonDir, "..");
      }
    } catch {
      // not a worktree, root is fine
    }

    return root;
  } catch {
    return null;
  }
}

// ── Decision engine ──

export function createInitialState(): GateState {
  return {
    mode: "careful",
    autoClassify: "off",
    gitRoot: null,
    allowedBashPrefixes: [],
    allowedPaths: [],
    allowedPathGlobs: [],
    toolOverrides: {},
    classifyCache: new Map(),
    autoAllowLog: [],
  };
}

/**
 * Given a verdict from the sidecar, should we auto-allow?
 * - Careful + auto: only SAFE auto-allows
 * - Trust-project + auto: SAFE and RISKY auto-allow
 */
export function shouldAutoAllow(verdict: "safe" | "risky" | "dangerous", mode: Mode): boolean {
  if (verdict === "dangerous") return false;
  if (verdict === "safe") return true;
  // RISKY: auto-allow in trust-project, confirm in careful
  return mode === "trust-project";
}

/** Simple hash for cache keys. */
export function cacheKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(input)}`;
}

/**
 * Decide what to do with a tool call. Returns a decision
 * that the extension UI layer acts on.
 */
export function decide(toolName: string, input: Record<string, unknown>, cwd: string, state: GateState): GateDecision {
  // Allow-all mode: pass everything
  if (state.mode === "allow-all") {
    return { action: "allow" };
  }

  // Delegation: the child's own gate decides what it may do, and this call
  // touches nothing in the parent. The subagent extension still confirms
  // project-local agent definitions itself (subagent/index.ts).
  if (DELEGATION_TOOLS.includes(toolName)) {
    return { action: "allow" };
  }

  // Read-only tools: always allow
  if (READ_ONLY_TOOLS.includes(toolName)) {
    return { action: "allow" };
  }

  // Tool-level override (e.g. "allow all edits")
  const override = state.toolOverrides[toolName];
  if (override === "allow") {
    // Still check sensitive files even with tool override
    if (EDIT_LIKE_TOOLS.includes(toolName)) {
      const projectRoot = state.gitRoot ?? cwd;
      for (const filePath of collectTargetPaths(toolName, input, cwd)) {
        const rel = relative(projectRoot, filePath);
        if (isSensitivePath(rel)) {
          return {
            action: "confirm",
            confirmType: "sensitive",
            displayPath: relative(cwd, filePath) || filePath,
          };
        }
      }
    }
    return { action: "allow" };
  }

  // Write/edit tools
  if (EDIT_LIKE_TOOLS.includes(toolName)) {
    const paths = collectTargetPaths(toolName, input, cwd);
    const projectRoot = state.gitRoot ?? cwd;

    // Malformed input (no resolvable path): confirm rather than guess.
    if (paths.length === 0) {
      return { action: "confirm", confirmType: "write", displayPath: toolName };
    }

    // Sensitive files: confirm unless that specific path is explicitly allowed.
    for (const filePath of paths) {
      const rel = relative(projectRoot, filePath);
      if (isSensitivePath(rel) && !isPathAllowed(filePath, cwd, state)) {
        return {
          action: "confirm",
          confirmType: "sensitive",
          displayPath: relative(cwd, filePath) || filePath,
        };
      }
    }

    // All target paths already allowed?
    if (paths.every((p) => isPathAllowed(p, cwd, state))) {
      return { action: "allow" };
    }

    // Careful: confirm everything
    if (state.mode === "careful") {
      const first = paths[0] ?? "";
      return {
        action: "confirm",
        confirmType: "write",
        displayPath: relative(cwd, first) || first,
      };
    }

    // Trust project: allow only if ALL targets are in-project
    if (state.mode === "trust-project") {
      const outside = paths.find((p) => !isInsideDir(p, projectRoot));
      if (!outside) {
        return { action: "allow" };
      }
      return {
        action: "confirm",
        confirmType: "outside-project",
        displayPath: relative(cwd, outside) || outside,
      };
    }
  }

  // Bash
  if (toolName === "bash") {
    const command = (input.command as string).trim();

    if (isBashAllowed(command, state)) {
      return { action: "allow" };
    }

    const prefix = suggestPrefix(command);
    const real = stripShellPreamble(command);
    // Did the prefix match but escalation blocked it?
    const escalation = hasShellEscalation(real) && state.allowedBashPrefixes.some((p) => real.startsWith(p));

    return {
      action: "confirm",
      confirmType: "bash",
      displayPath: command,
      suggestedPrefix: prefix,
      escalation,
    };
  }

  // Unknown tool: confirm in careful, allow in trust-project
  if (state.mode === "careful") {
    return { action: "confirm", reason: `Unknown tool: ${toolName}` };
  }

  return { action: "allow" };
}
