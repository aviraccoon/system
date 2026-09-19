/**
 * Edit-tool diff preview for the permission gate's confirm dialog.
 * Matching: ./edit-match (vendored from pi's unexported edit-diff internals).
 * Rendering: pi's public generateDiffString.
 */

import { access, constants, readFile } from "node:fs/promises";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { diffLineCounts, pluralLines } from "../shared/diff";
import { applyEditsToNormalizedContent, type EditOp, normalizeToLF, resolveEditPath } from "./edit-match";

export interface EditPreview {
  /** Display diff (+/- lines with line numbers, upstream format). */
  diff: string;
  /** First changed line (1-based, new file) — same source as patch previews use. */
  firstChangedLine?: number;
  /** One-line account of the change for the classifier's state. */
  summary: string;
}

export interface WritePreview {
  /** Display diff (+/- lines with line numbers, upstream format). */
  diff: string;
  /** First changed line (1-based, new file). */
  firstChangedLine?: number;
  /** One-line account of the change for the classifier's state. */
  summary: string;
}

export type EditPreviewResult = EditPreview | { error: string };

/** Read errors that mean "there is no file to overwrite". */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Compute what a write call would change, without writing. Reads the target, so a
 * create and an overwrite are distinguishable: the gate used to fabricate an
 * all-additions diff from the tool's own content, which made every write look like
 * a new file, and the risk factors key on exactly that difference.
 */
export async function computeWritePreview(path: string, content: string, cwd: string): Promise<WritePreview> {
  const absolutePath = resolveEditPath(path, cwd);
  let existing: string | null = null;
  try {
    existing = await readFile(absolutePath, "utf-8");
  } catch (err) {
    const code = err instanceof Error && "code" in err ? String(err.code) : "unknown";
    if (!ABSENT_CODES.has(code)) {
      // The path exists but is unreadable (EISDIR, EACCES), or the read failed for
      // another reason: claiming a new file would understate the change.
      return { diff: "", summary: `overwrites an unreadable existing file (${code})` };
    }
  }
  const { diff, firstChangedLine } = generateDiffString(existing ?? "", content);
  const { added, removed } = diffLineCounts(diff);
  const summary =
    existing === null
      ? `creates a new file: ${pluralLines(added)}`
      : `overwrites the existing file: removes ${pluralLines(removed)}, adds ${pluralLines(added)}`;
  return { diff, firstChangedLine, summary };
}

/**
 * Compute what a built-in edit call would change, without writing. Returns
 * {error} exactly when pi's own preview would refuse: file unreadable or an
 * edit-rejection condition in ./edit-match. The gate treats that as
 * "no styled diff" and confirms with details instead.
 */
export async function computeEditPreview(
  path: string,
  edits: Array<{ oldText?: string; newText?: string }>,
  cwd: string,
): Promise<EditPreviewResult> {
  if (!path) return { error: "edit: no path given" };
  const normalizedEdits: EditOp[] = edits.map((e) => ({ oldText: e.oldText ?? "", newText: e.newText ?? "" }));
  const absolutePath = resolveEditPath(path, cwd);
  try {
    try {
      await access(absolutePath, constants.R_OK);
    } catch (err) {
      const code = err instanceof Error && "code" in err ? err.code : String(err);
      return { error: `Could not edit file: ${path}. Error code: ${code}.` };
    }
    const rawContent = await readFile(absolutePath, "utf-8");
    // Strip BOM before matching (LLM won't include invisible BOM in oldText)
    const content = rawContent.startsWith("\uFEFF") ? rawContent.slice(1) : rawContent;
    const { baseContent, newContent } = applyEditsToNormalizedContent(normalizeToLF(content), normalizedEdits, path);
    const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);
    const { added, removed } = diffLineCounts(diff);
    return {
      diff,
      firstChangedLine,
      summary: `edits the existing file: removes ${pluralLines(removed)}, adds ${pluralLines(added)}`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
