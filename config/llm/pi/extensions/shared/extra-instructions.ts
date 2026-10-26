/**
 * Project instructions declared in a journal project's meta.json, inlined at
 * session start.
 *
 *   "instructions": [
 *     "~/notes/llm/example-work-rules.md",
 *     { "path": "~/notes/llm/example-child-rules.md", "subagents": true }
 *   ]
 *
 * A plain string loads for the main agent. The object form with
 * `subagents: true` also loads in subagent children, which pay the tokens on
 * every dispatch — so the default is main-only.
 *
 * Paths are `~`-expanded, or resolved against the project's journal dir (where
 * the meta.json lives). Callers resolve the project worktree-aware (`projectFor`),
 * so a worktree session and its checkout share `baseDir`.
 *
 * A missing or unreadable file is reported inside the block rather than
 * skipped: these instructions decide what the agent may do, and silently
 * losing them is the failure mode that must stay visible.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { expandTilde } from "./paths";

/** One entry of meta.json's `instructions` array. */
export type InstructionEntry = string | { path: string; subagents?: boolean };

/** Who is loading: the main agent, or a subagent child. */
export type InstructionAudience = "main" | "subagent";

/** The paths an audience should load, in declaration order, deduplicated. */
export function instructionPaths(instructions: unknown, audience: InstructionAudience): string[] {
  if (!Array.isArray(instructions)) return [];

  const paths: string[] = [];
  for (const entry of instructions) {
    const path = entryPath(entry);
    if (path === null) continue;
    const forSubagents = typeof entry !== "string" && entry.subagents === true;
    if (audience === "subagent" && !forSubagents) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * Why an entry cannot be loaded, or null when it can. Dropping a bad entry is
 * not enough on its own: `declaredInstructionsWarning` names it, so a typo in a
 * key does not look like "nothing was declared".
 */
function entryIssue(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim() === "" ? "is an empty string" : null;
  if (!isEntry(entry) || entry.path.trim() === "") return "has no `path` string";
  if (entry.subagents !== undefined && typeof entry.subagents !== "boolean") {
    return "has a `subagents` value that is not true or false";
  }
  return null;
}

/** The path an entry names, or null when the entry is malformed. */
function entryPath(entry: unknown): string | null {
  if (entryIssue(entry) !== null) return null;
  return typeof entry === "string" ? entry : (entry as { path: string }).path;
}

function isEntry(value: unknown): value is { path: string; subagents?: boolean } {
  return typeof value === "object" && value !== null && typeof (value as { path?: unknown }).path === "string";
}

/** Only `~` and `~/` are expanded; `~user` is treated as a relative path. */
export function expandInstructionPath(path: string, baseDir: string): string {
  const expanded = expandTilde(path.trim());
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

/** The block header; the file tags below it name each source. */
const HEADER = "Project instructions (declared in this project's meta.json, loaded at session start):";

export const MISSING_INSTRUCTION =
  "MISSING, UNREADABLE OR EMPTY — stop and surface this to the user before continuing; do not guess what it said.";

/**
 * Render the instruction block for `paths`. Returns "" when there is nothing to
 * load, so callers can append it unconditionally.
 */
export function formatInstructions(paths: string[], baseDir: string): string {
  if (paths.length === 0) return "";

  const blocks = paths.map((path) => {
    const abs = expandInstructionPath(path, baseDir);
    let content: string;
    try {
      content = readFileSync(abs, "utf-8").replace(/\n+$/, "");
      if (content.trim() === "") content = MISSING_INSTRUCTION;
    } catch {
      content = MISSING_INSTRUCTION;
    }
    return `<file name="${abs}">\n${content}\n</file>`;
  });

  return `${HEADER}\n${blocks.join("\n\n")}`;
}

/** Resolve a meta.json `instructions` value for one audience. */
export function projectInstructions(instructions: unknown, audience: InstructionAudience, baseDir: string): string {
  return formatInstructions(instructionPaths(instructions, audience), baseDir);
}

/**
 * A meta.json that exists but cannot be read as an object, or whose
 * `instructions` value has the wrong shape, yields no block — which must not
 * look like "nothing was declared". Returns "" when there is nothing to report.
 */
export function declaredInstructionsWarning(meta: { instructions?: unknown } | null, projectDir: string): string {
  const metaPath = join(projectDir, "meta.json");
  if (meta === null) {
    if (!existsSync(metaPath)) return "";
    // Distinguish a broken file from a valid one with the wrong top level: the
    // agent has to open it either way, and the fix is different.
    try {
      JSON.parse(readFileSync(metaPath, "utf-8"));
    } catch {
      return `Project instructions: ${metaPath} could not be read as JSON, so no declared instructions were loaded — fix the file.`;
    }
    return `Project instructions: the top level of ${metaPath} must be an object, so no declared instructions were loaded — fix the file.`;
  }
  if (meta.instructions !== undefined && !Array.isArray(meta.instructions)) {
    return `Project instructions: \`instructions\` in ${metaPath} must be an array, so none were loaded — fix the file.`;
  }
  if (Array.isArray(meta.instructions)) {
    // A malformed entry is dropped; say which and why, or a wrong key reads as
    // "nothing was declared" while the file plainly declares something.
    const index = meta.instructions.findIndex((entry) => entryIssue(entry) !== null);
    if (index >= 0) {
      const issue = entryIssue(meta.instructions[index]);
      return `Project instructions: entry ${index + 1} of \`instructions\` in ${metaPath} ${issue}, so it was not loaded — fix the file.`;
    }
  }
  return "";
}
