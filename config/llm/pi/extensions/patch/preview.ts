/**
 * Diff preview for the patch tool, used by the permission gate's confirm
 * dialog. Computes what patch WOULD change without writing.
 *
 * Uses patch's OWN matcher (planAll + applyPreservingOriginal), not pi's
 * built-in computeEditsDiff — because patch's tolerant matching (arrows,
 * tab↔space, smart quotes) is exactly the case where a preview is most useful,
 * and pi's matcher can't represent it (it would return "not found" for edits
 * patch applies fine, showing a misleading empty preview in the gate).
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { diffLineCounts, pluralLines } from "../shared/diff";
import { findDuplicationIssues } from "./diagnostics";
import {
  applyPreservingOriginal,
  detectLineEnding,
  type Edit,
  normalizeToLF,
  planAll,
  restoreLineEndings,
  stripBom,
} from "./match";

export interface PatchPreview {
  /** Renderable diff text (pi-style +/-/ with line numbers). */
  diff: string;
  /** First changed line (1-based, in the new file) for scroll position. */
  firstChangedLine?: number;
  /** One-line account of the change for the classifier's state. */
  summary: string;
}

/** Group edits by resolved absolute path (multi-file). */
function groupByPath(topPath: string, edits: Edit[], cwd: string): Map<string, { displayPath: string; edits: Edit[] }> {
  const groups = new Map<string, { displayPath: string; edits: Edit[] }>();
  for (const edit of edits) {
    const raw = edit.path ?? topPath;
    const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
    const abs = resolve(cwd, stripped);
    const existing = groups.get(abs);
    if (existing) {
      existing.edits.push(edit);
    } else {
      groups.set(abs, { displayPath: raw, edits: [edit] });
    }
  }
  return groups;
}

/**
 * Compute a diff preview for a patch call without writing. Returns undefined
 * if no diff can be produced (file unreadable, no matches, no net change).
 */
export async function computePatchPreview(
  topPath: string,
  edits: Edit[],
  cwd: string,
): Promise<PatchPreview | undefined> {
  const groups = groupByPath(topPath, edits, cwd);
  const parts: string[] = [];
  let firstChangedLine: number | undefined;
  let addedTotal = 0;
  let removedTotal = 0;

  for (const [absPath, { displayPath, edits: groupEdits }] of groups) {
    let buffer: Buffer;
    try {
      buffer = await readFile(absPath);
    } catch {
      return undefined;
    }
    const rawContent = buffer.toString("utf-8");
    const { bom, text } = stripBom(rawContent);
    const ending = detectLineEnding(text);
    const content = normalizeToLF(text);

    const plan = planAll(content, groupEdits);
    // If ANY edit has diagnostics (no-match, ambiguous, empty, overlap), the
    // call will fail atomically — nothing will be written. Return undefined so
    // the permission gate knows to skip confirmation (the tool will throw its
    // own diagnostics; asking the user to approve a doomed edit wastes time).
    const hasDiagnostics = plan.outcomes.some((o) => o.status !== "applied");
    if (hasDiagnostics || (plan.replacements.length === 0 && plan.insertions.length === 0)) return undefined;

    // Boundary duplication / insert duplication: these are caught at
    // execution time in planFiles, but we need to catch them here too so
    // the preview doesn't show a diff for a doomed edit. Without this the
    // permission gate shows a diff, the user approves, and the tool rejects.
    if (findDuplicationIssues(content, plan, groupEdits).length > 0) return undefined;

    const newContent = bom + restoreLineEndings(applyPreservingOriginal(content, plan), ending);
    const lfNew = normalizeToLF(newContent);
    if (lfNew === content) return undefined;

    const { diff, firstChangedLine: fcl } = generateDiffString(content, lfNew);
    if (firstChangedLine === undefined) firstChangedLine = fcl;
    // Count per file, before the multi-file separator joins the diffs.
    const counts = diffLineCounts(diff);
    addedTotal += counts.added;
    removedTotal += counts.removed;
    parts.push(groups.size > 1 ? `--- ${displayPath} ---\n${diff}` : diff);
  }

  if (parts.length === 0) return undefined;
  const stats = `removes ${pluralLines(removedTotal)}, adds ${pluralLines(addedTotal)}`;
  const summary = groups.size === 1 ? `edits the existing file: ${stats}` : `edits ${groups.size} files: ${stats}`;
  return { diff: parts.join("\n\n"), firstChangedLine, summary };
}
