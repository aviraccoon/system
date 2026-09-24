/**
 * Prose gate: edits to audience prose require the writing-style skill loaded
 * this session. Advisory prompt surfaces (the skill's description, the
 * instructions line) do not reliably trigger — the task framing decides the
 * category match, and "apply a dictated correction" never reads as "write
 * prose". Blocking the edit makes the read the path of least resistance.
 *
 * Journal and session files are exempt: the journal is agent-private work,
 * not audience prose.
 *
 * Pure helpers only — no pi imports; session state lives in index.ts.
 */

import { homedir } from "node:os";
import { extname, join } from "node:path";
import { type RuntimeRoots, under } from "./rules";

export const WRITING_STYLE_SKILL_PATH = join(homedir(), ".pi", "agent", "skills", "writing-style", "SKILL.md");

// Text-first prose formats: files whose primary content is prose. Code files
// are excluded on purpose — comments in them are the reviewer pass's job, and
// gating every code edit on a prose skill would make the gate background noise.
const PROSE_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".org", ".tex", ".typ"]);

/** True when an edit target requires the writing-style skill loaded this session. */
export function isGatedProsePath(abs: string, roots: RuntimeRoots): boolean {
  if (!PROSE_EXTENSIONS.has(extname(abs).toLowerCase())) return false;
  return !under(roots.notesDir, abs) && !under(roots.sessionsDir, abs);
}

/** True when a read path or shell command references the skill file. Boundary
 * matching keeps `cd <dir> && cat SKILL.md` working and skips
 * `writing-style-something` dir names. */
export function mentionsWritingStyleSkill(text: string): boolean {
  return /writing-style(?![a-z-])/.test(text) && text.includes("SKILL.md");
}

/** Self-contained block reason: the agent sees only this, not the session. */
export function proseGateReason(displayPath: string): string {
  return (
    `edit-guard: ${displayPath} is prose and the writing-style skill is not loaded this session. ` +
    `Read ${WRITING_STYLE_SKILL_PATH} with the read tool, then re-issue this edit — ` +
    "the guide governs any prose another person will read: docs, instructions, READMEs, commit messages, " +
    "code comments. The gate clears for the session once the skill is loaded."
  );
}
