/**
 * The one parser for a journal project's meta.json.
 *
 * Every field is validated here, once. Everything downstream reads a
 * `ProjectMeta` whose types are true by construction — `harvest.note` is a
 * string, an instruction has a path — so no caller re-checks a shape, and a new
 * field is one row in this file plus one row in its table test.
 *
 * The parser never throws and never drops a declaration without a problem naming
 * it: it returns the readable fields plus problems, each a sentence an agent can
 * act on. Callers
 * inject those problems next to the context they build, because a settings file
 * that lost half of itself must not read as "nothing was declared".
 *
 * Boundary: the fields here are the ones the shared context builder injects,
 * because that builder also runs where no extension runtime exists (the Claude
 * Code hooks and the OpenCode plugin). A setting only one pi extension reads
 * belongs in that extension's own config file — `model-policy` reads
 * `model-policies.json` that way — not in this schema.
 */

/** Which agent is loading: the main session, or a subagent child. */
export type InstructionAudience = "main" | "subagent";

/** One file a project inlines at session start. */
export interface Instruction {
  path: string;
  /** Also load in subagent children, which pay the tokens on every dispatch. */
  subagents: boolean;
}

/** Present = the harvest flag is on; the note is extra policy. */
export interface HarvestSetting {
  note?: string;
}

export interface ProjectMeta {
  description?: string;
  path?: string;
  harvest?: HarvestSetting;
  /** Declared files, deduplicated, in declaration order. Always an array. */
  instructions: Instruction[];
}

export interface ParsedMeta {
  meta: ProjectMeta;
  /** Sentences naming what was dropped and how to fix it; empty when the file is clean. */
  problems: string[];
}

export function emptyProjectMeta(): ProjectMeta {
  return { instructions: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const KNOWN_KEYS = new Set(["description", "path", "harvest", "instructions"]);
const KNOWN_HARVEST_KEYS = new Set(["note"]);
const KNOWN_ENTRY_KEYS = new Set(["path", "subagents"]);

/**
 * Keys the value carries that its schema does not read. Every object this schema
 * parses calls it; a new nested object needs its own call.
 */
function unknownKeys(value: Record<string, unknown>, known: Set<string>): string[] {
  return Object.keys(value).filter((key) => !known.has(key));
}

/** Parse a meta.json object that already parsed as JSON. Pure. */
export function parseProjectMeta(raw: Record<string, unknown>, metaPath: string): ParsedMeta {
  const problems: string[] = [];
  const meta = emptyProjectMeta();

  for (const key of unknownKeys(raw, KNOWN_KEYS)) {
    problems.push(`unknown key \`${key}\` in ${metaPath}, which was ignored — check the spelling.`);
  }

  if (raw.description !== undefined) {
    if (typeof raw.description === "string") meta.description = raw.description;
    else problems.push(`\`description\` in ${metaPath} must be a string, so it was ignored — fix the file.`);
  }

  if (raw.path !== undefined) {
    if (typeof raw.path === "string") meta.path = raw.path;
    else problems.push(`\`path\` in ${metaPath} must be a string, so it was ignored — fix the file.`);
  }

  // The flag is normalized to an object when on, so consumers read `meta.harvest`
  // alone: present means track time.
  if (raw.harvest === true) {
    meta.harvest = {};
  } else if (raw.harvest !== undefined && raw.harvest !== false) {
    if (!isPlainObject(raw.harvest)) {
      problems.push(
        `\`harvest\` in ${metaPath} must be true or an object with a note, so the harvest policy was not injected — fix the file.`,
      );
    } else {
      for (const key of unknownKeys(raw.harvest, KNOWN_HARVEST_KEYS)) {
        problems.push(`unknown key \`${key}\` in \`harvest\` in ${metaPath}, which was ignored — check the spelling.`);
      }
      meta.harvest = {};
      const note = raw.harvest.note;
      if (typeof note === "string" && note.trim() !== "") meta.harvest.note = note.trim();
      else if (note !== undefined && typeof note !== "string") {
        problems.push(`\`harvest.note\` in ${metaPath} must be a string, so the note was ignored — fix the file.`);
      }
    }
  }

  if (raw.instructions !== undefined) {
    if (!Array.isArray(raw.instructions)) {
      problems.push(`\`instructions\` in ${metaPath} must be an array, so none were loaded — fix the file.`);
    } else {
      for (const [index, entry] of raw.instructions.entries()) {
        const problem = (issue: string) =>
          problems.push(`entry ${index + 1} of \`instructions\` in ${metaPath} ${issue} — fix the file.`);

        let path: string | null = null;
        let subagents = false;
        if (typeof entry === "string") {
          if (entry.trim() === "") problem("is an empty string, so it was not loaded");
          else path = entry;
        } else if (!isPlainObject(entry)) {
          problem("is neither a string nor an object with a path, so it was not loaded");
        } else if (typeof entry.path !== "string" || entry.path.trim() === "") {
          problem("has no `path` string, so it was not loaded");
        } else if (entry.subagents !== undefined && typeof entry.subagents !== "boolean") {
          problem("has a `subagents` value that is not true or false, so it was not loaded");
        } else {
          for (const key of unknownKeys(entry, KNOWN_ENTRY_KEYS)) {
            problem(`has an unknown key \`${key}\`, which was ignored`);
          }
          path = entry.path;
          subagents = entry.subagents === true;
        }

        if (path !== null) {
          // A second declaration of the same path merges: the widest audience wins,
          // so a `subagents: true` repeat is not lost to the first plain entry.
          const existing = meta.instructions.find((candidate) => candidate.path === path);
          if (existing) existing.subagents = existing.subagents || subagents;
          else meta.instructions.push({ path, subagents });
        }
      }
    }
  }

  return { meta, problems };
}

/** Present means track time; the parser keeps it only for a declared flag. */
export function harvestEnabled(meta: ProjectMeta): boolean {
  return meta.harvest !== undefined;
}

/** The instructions an audience should load, in declaration order. */
export function instructionsFor(meta: ProjectMeta, audience: InstructionAudience): Instruction[] {
  return audience === "main" ? meta.instructions : meta.instructions.filter((entry) => entry.subagents);
}

/** Render problems as one block, or "" when there are none. */
export function formatMetaProblems(problems: string[]): string {
  if (problems.length === 0) return "";
  return `Project settings problems (from this project's meta.json):\n${problems.map((p) => `- ${p}`).join("\n")}`;
}
