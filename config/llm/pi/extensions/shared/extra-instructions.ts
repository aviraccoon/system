/**
 * Rendering of the files a project declares under `instructions`.
 *
 * Shape validation lives in ./project-meta.ts: by the time this module runs, an
 * instruction has a non-empty path. Here we only expand paths and format the
 * block, one `<file>` tag per source so the agent can see where each came from.
 *
 * A missing or unreadable file is reported inside the block rather than skipped:
 * these instructions decide what the agent may do, and silently losing them is
 * the failure mode that must stay visible.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { expandTilde } from "./paths";
import { type InstructionAudience, instructionsFor, type ProjectMeta } from "./project-meta";

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

/** Render the block for one audience of a parsed project's declarations. */
export function projectInstructions(meta: ProjectMeta, audience: InstructionAudience, baseDir: string): string {
  return formatInstructions(
    instructionsFor(meta, audience).map((entry) => entry.path),
    baseDir,
  );
}
