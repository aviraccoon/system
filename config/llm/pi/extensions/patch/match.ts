/**
 * Pure matching engine for the patch tool. No pi imports — bun-testable.
 *
 * Architecture (pi's proven two-space model, with consensus extensions):
 *   exact whole-string match  →  normalized fuzzy match  →  closest-match diagnostics
 *
 * A batch is matched in ONE space: if every edit has an exact match, original
 * content is used; otherwise ALL edits are matched in normalized space. This
 * avoids mixed-space offset bugs. (Same design as pi's edit-diff.js.)
 *
 * normalizeForFuzzyMatch extends pi's built-in (smart quotes, dashes via NFKC,
 * special spaces) with commonly ASCII-folded symbols (arrows, math, bullet,
 * box-pipe) and internal-whitespace collapse (handles tab↔space drift).
 *
 * Original bytes on untouched lines are preserved: when matched in normalized
 * space, each replacement is widened to whole lines and only those touched line
 * groups are rewritten; all other lines keep their original bytes verbatim.
 * (Ported from pi's applyReplacementsPreservingUnchangedLines.)
 *
 * See README.md for full design rationale.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface Edit {
  oldText: string;
  newText: string;
  path?: string;
  /** Unique nearby string; when oldText matches multiple times, pick the
   * occurrence nearest this anchor. Self-validating (model can verify it
   * exists), unlike a line number. */
  anchor?: string;
  /** Apply to all occurrences (intentional non-unique). */
  replaceAll?: boolean;
  /** How to apply. "replace" (default) rewrites the matched block with newText.
   * "insertAfter"/"insertBefore" treat oldText as a unique anchor and insert
   * newText (new content ONLY) after/before the matched block at a line
   * boundary. The anchor is never re-emitted, so its bytes are preserved and
   * there is no indentation-drift surface; newText is inserted verbatim. */
  mode?: "replace" | "insertAfter" | "insertBefore";
  /** Insert-only. Allow newText to repeat the anchor line (default false). The
   * insert dup-guard rejects newText that re-includes the anchor; set this for
   * the legitimate "repeat and extend" idiom (e.g. append a line that happens
   * to match the anchor). Ignored for replace mode. */
  allowAnchorRepeat?: boolean;
}

export type MatchKind = "exact" | "normalized";

export interface MatchHit {
  /** 1-based line number (consistent across original and normalized spaces —
   * normalization preserves the \n structure, so line indices are identical). */
  line: number;
  /** Number of original lines the matched block spans. */
  lineCount: number;
  kind: MatchKind;
  /** Common leading whitespace of the matched block (from original bytes). */
  fileIndent: string;
}

// ── File-level normalization (the fuzzy space) ─────────────────────────────

/**
 * Normalize for fuzzy matching. Extends pi's normalizeForFuzzyMatch with
 * commonly ASCII-folded symbols and internal-whitespace collapse (the latter is
 * what lets tab↔space and indentation drift match).
 *
 * Only loosens MATCHING; matched regions are overlaid back onto original bytes.
 * Preserves line count (splits/joins on \n; replacements never add/remove \n).
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Smart single quotes → '
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      // Smart double quotes → "
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // Various dashes/hyphens → -
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // Arrows → ASCII (single then double)
      .replace(/[\u2190\u2192\u2194\u21A6\u21C4]/g, (c) => ARROW_MAP[c] ?? c)
      .replace(/[\u21D0\u21D2\u21D4]/g, (c) => DOUBLE_ARROW_MAP[c] ?? c)
      // Math symbols → ASCII
      .replace(/\u2260/g, "!=")
      .replace(/\u2264/g, "<=")
      .replace(/\u2265/g, ">=")
      .replace(/\u2248/g, "~=")
      .replace(/\u00B1/g, "+/-")
      .replace(/[\u00D7\u2715]/g, "*")
      .replace(/\u00F7/g, "/")
      .replace(/[\u00B7\u2022]/g, "*")
      // Box drawing pipe → |
      .replace(/[\u2502\u2503\uFF5C]/g, "|")
      // Ellipsis → ...
      .replace(/\u2026/g, "...")
      // Special spaces → regular space
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
      // Collapse remaining [ \t]+ runs to single space per line
      .replace(/[ \t]+/g, " ")
  );
}

const ARROW_MAP: Record<string, string> = {
  "\u2190": "<-",
  "\u2192": "->",
  "\u2194": "<->",
  "\u21A6": "->",
  "\u21C4": "<->",
};
const DOUBLE_ARROW_MAP: Record<string, string> = {
  "\u21D0": "<=",
  "\u21D2": "=>",
  "\u21D4": "<=>",
};

// ── BOM / line endings ─────────────────────────────────────────────────────

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ── Line structure ─────────────────────────────────────────────────────────

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
  start: number;
  end: number;
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

/** 1-based line number for a char offset. */
export function lineForOffset(content: string, offset: number): number {
  const spans = getLineSpans(content);
  for (let i = 0; i < spans.length; i++) {
    if (offset >= spans[i].start && offset < spans[i].end) return i + 1;
  }
  return spans.length;
}

/** Lines of content with no trailing newline (for diagnostics). */
export function contentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Common leading whitespace of a block (skips blank lines). */
function detectIndent(block: string): string {
  let indent: string | null = null;
  for (const line of block.split("\n")) {
    if (line.trim().length === 0) continue;
    const lead = line.match(/^[ \t]*/)?.[0] ?? "";
    indent = indent === null ? lead : commonPrefix(indent, lead);
    if (indent.length === 0) break;
  }
  return indent ?? "";
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  const min = Math.min(a.length, b.length);
  while (i < min && a[i] === b[i]) i++;
  return a.slice(0, i);
}

// ── Anchor resolution ──────────────────────────────────────────────────────

/** All 1-based lines where anchor (exact) occurs in content. */
export function findAnchorLines(content: string, anchor: string): number[] {
  const a = normalizeToLF(anchor);
  if (!a) return [];
  const lines: number[] = [];
  let from = 0;
  let idx = content.indexOf(a, from);
  while (idx !== -1) {
    lines.push(lineForOffset(content, idx));
    from = idx + a.length;
    idx = content.indexOf(a, from);
  }
  return lines;
}

// ── Core matching ──────────────────────────────────────────────────────────

interface RawOccurrence {
  /** Offset in the match space (original or normalized). */
  start: number;
  length: number;
}

/** Count occurrences of needle in haystack. */
function countIn(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  let idx = haystack.indexOf(needle, from);
  while (idx !== -1) {
    count++;
    from = idx + needle.length;
    idx = haystack.indexOf(needle, from);
  }
  return count;
}

/** All occurrences of needle in haystack. */
function findAllIn(haystack: string, needle: string): RawOccurrence[] {
  const out: RawOccurrence[] = [];
  if (!needle) return out;
  let from = 0;
  let idx = haystack.indexOf(needle, from);
  while (idx !== -1) {
    out.push({ start: idx, length: needle.length });
    from = idx + needle.length;
    idx = haystack.indexOf(needle, from);
  }
  return out;
}

/**
 * Public hit enumeration for diagnostics. Tries exact first; if none, falls
 * back to normalized. Returns line numbers + kind + file indent.
 */
export function findHits(content: string, oldText: string): MatchHit[] {
  const occurrences = resolveOccurrences(content, oldText);
  return occurrences.hits.map((h) => buildHit(content, occurrences.space, h));
}

interface OccurrenceResolution {
  space: "exact" | "normalized";
  /** The content in match space (original for exact, normalized otherwise). */
  matchSpace: string;
  hits: RawOccurrence[];
}

/**
 * Resolve all occurrences of oldText. Exact matches are preferred: if any
 * exist, the whole resolution is exact-space. Otherwise normalized-space.
 */
function resolveOccurrences(content: string, oldText: string): OccurrenceResolution {
  const exactHits = findAllIn(content, oldText);
  if (exactHits.length > 0) {
    return { space: "exact", matchSpace: content, hits: exactHits };
  }
  const normalized = normalizeForFuzzyMatch(content);
  const normNeedle = normalizeForFuzzyMatch(oldText);
  return { space: "normalized", matchSpace: normalized, hits: findAllIn(normalized, normNeedle) };
}

function buildHit(content: string, space: "exact" | "normalized", occ: RawOccurrence): MatchHit {
  const line = lineForOffset(space === "exact" ? content : normalizeForFuzzyMatch(content), occ.start);
  // For indent detection, use the ORIGINAL line content (line indices align).
  const lineCount = normalizedLineCount(space, content, occ);
  const origLines = contentLines(content);
  const block = origLines.slice(line - 1, line - 1 + lineCount).join("\n");
  return { line, lineCount, kind: space, fileIndent: detectIndent(block) };
}

/** How many original lines a normalized-space occurrence spans. */
function normalizedLineCount(space: "exact" | "normalized", content: string, occ: RawOccurrence): number {
  if (space === "exact") return content.slice(occ.start, occ.start + occ.length).split("\n").length;
  const normalized = normalizeForFuzzyMatch(content);
  const needle = normalized.slice(occ.start, occ.start + occ.length);
  return needle.split("\n").length;
}

// ── Auto-indent adjustment ─────────────────────────────────────────────────

/**
 * Re-indent newText to the file's actual indentation at the match site.
 * newText's relative indentation is preserved by re-basing from its own common
 * indent onto the file's.
 */
export function adjustIndentation(newText: string, fileIndent: string): string {
  const newIndent = detectIndent(newText);
  if (newIndent === fileIndent) return newText;
  return newText
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) return line;
      if (line.startsWith(newIndent)) return fileIndent + line.slice(newIndent.length);
      return fileIndent + line.trimStart();
    })
    .join("\n");
}

// ── Planning (single file) ─────────────────────────────────────────────────

export interface PlannedReplacement {
  editIndex: number;
  /** Offset in matchSpace. */
  start: number;
  length: number;
  newText: string;
  kind: MatchKind;
}

export interface PlannedInsertion {
  editIndex: number;
  /** 1-based original line to insert before (clamped to [1, totalLines+1];
   * totalLines+1 = append at end). */
  beforeLine: number;
  /** Verbatim new content (LF-normalized). */
  newText: string;
  /** True when an anchor disambiguated the match. */
  anchored: boolean;
  mode: "insertAfter" | "insertBefore";
}

export type EditOutcome =
  | { editIndex: number; status: "applied"; hits: MatchHit[] }
  | { editIndex: number; status: "no-op"; hits: MatchHit[] }
  | { editIndex: number; status: "no-match" }
  | { editIndex: number; status: "ambiguous"; hits: MatchHit[] }
  | { editIndex: number; status: "empty" };

export interface PlanResult {
  /** The match space used for the whole batch. */
  space: "exact" | "normalized";
  replacements: PlannedReplacement[];
  insertions: PlannedInsertion[];
  outcomes: EditOutcome[];
}

function finalizeNewText(rawNewText: string, hit: MatchHit): string {
  const newText = normalizeToLF(rawNewText);
  return hit.kind === "normalized" ? adjustIndentation(newText, hit.fileIndent) : newText;
}

/**
 * Is a replacement a no-op — i.e. would it write the same bytes that are
 * already there? Uses the SAME space the applier splices into (original
 * content for exact matches, the normalized form for normalized matches), so
 * this is guaranteed consistent with `applyPreservingOriginal`: if newText
 * equals the matched slice here, that replacement contributes zero byte
 * change there. Catches the footgun where oldText and newText are pasted
 * byte-identical (no real intent to change), even when mixed with edits that
 * DO change the file — the whole-file guard can't see that case.
 */
function isNoOpReplacement(matchSpace: string, rep: { start: number; length: number; newText: string }): boolean {
  return rep.newText === matchSpace.slice(rep.start, rep.start + rep.length);
}

/** Compute the 1-based original line to insert before, for a matched block.
 * insertAfter → the line after the block; insertBefore → the block's first
 * line. Clamped to [1, totalLines+1] (totalLines+1 = append at end). */
function beforeLineFor(mode: "insertAfter" | "insertBefore", hit: MatchHit, totalLines: number): number {
  const raw = mode === "insertAfter" ? hit.line + hit.lineCount : hit.line;
  return Math.min(Math.max(raw, 1), totalLines + 1);
}

/**
 * Plan all edits against one file's content. Determines the batch's match space
 * (exact if all edits exact-match, else normalized for the whole batch),
 * enumerates occurrences per edit, applies anchor/replaceAll/unique selection,
 * and detects cross-edit overlaps.
 */
export function planAll(content: string, edits: Edit[]): PlanResult {
  // First pass: determine the batch's match space.
  const normalized = normalizeForFuzzyMatch(content);
  const useNormalized = edits.some((edit) => {
    const oldText = normalizeToLF(edit.oldText);
    return oldText.length > 0 && countIn(content, oldText) === 0;
  });
  const space: "exact" | "normalized" = useNormalized ? "normalized" : "exact";
  const matchSpace = space === "normalized" ? normalized : content;

  const replacements: PlannedReplacement[] = [];
  const insertions: PlannedInsertion[] = [];
  const outcomes: EditOutcome[] = [];
  const fileLineCount = contentLines(content).length;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit) continue;
    const oldText = normalizeToLF(edit.oldText);
    if (oldText.length === 0) {
      outcomes.push({ editIndex: i, status: "empty" });
      continue;
    }
    const needle = space === "normalized" ? normalizeForFuzzyMatch(oldText) : oldText;
    const occurrences = findAllIn(matchSpace, needle);

    if (occurrences.length === 0) {
      outcomes.push({ editIndex: i, status: "no-match" });
      continue;
    }

    const hits = occurrences.map((occ) => buildHit(content, space, occ));

    // Insert modes: oldText is a unique anchor; newText (new content only) is
    // spliced at a line boundary after/before the matched block. The anchor is
    // never re-emitted from newText, so there's no indentation-drift surface.
    if (edit.mode === "insertAfter" || edit.mode === "insertBefore") {
      const mode = edit.mode;
      const newRaw = normalizeToLF(edit.newText);
      if (newRaw.length === 0) {
        outcomes.push({ editIndex: i, status: "empty" });
        continue;
      }
      if (edit.replaceAll) {
        for (const hit of hits) {
          insertions.push({
            editIndex: i,
            beforeLine: beforeLineFor(mode, hit, fileLineCount),
            newText: newRaw,
            anchored: false,
            mode,
          });
        }
        outcomes.push({ editIndex: i, status: "applied", hits });
        continue;
      }
      if (occurrences.length > 1) {
        if (edit.anchor) {
          const anchorLines = findAnchorLines(content, edit.anchor);
          if (anchorLines.length > 0) {
            const chosen = nearestOccurrence(occurrences, anchorLines, matchSpace);
            if (chosen) {
              const hit = buildHit(content, space, chosen);
              insertions.push({
                editIndex: i,
                beforeLine: beforeLineFor(mode, hit, fileLineCount),
                newText: newRaw,
                anchored: true,
                mode,
              });
              outcomes.push({ editIndex: i, status: "applied", hits: [hit] });
              continue;
            }
          }
        }
        outcomes.push({ editIndex: i, status: "ambiguous", hits });
        continue;
      }
      const occ = occurrences[0];
      if (occ) {
        const hit = buildHit(content, space, occ);
        insertions.push({
          editIndex: i,
          beforeLine: beforeLineFor(mode, hit, fileLineCount),
          newText: newRaw,
          anchored: Boolean(edit.anchor),
          mode,
        });
        outcomes.push({ editIndex: i, status: "applied", hits: [hit] });
      }
      continue;
    }

    // Build candidate replacements for this edit, then drop the no-op ones
    // (newText byte-identical to what's matched). An edit whose candidates
    // are ALL no-ops reports status "no-op" so the caller can flag it instead
    // of silently counting it as applied.
    const candidates: PlannedReplacement[] = [];
    const addCandidate = (occ: RawOccurrence) => {
      const hit = buildHit(content, space, occ);
      const rep: PlannedReplacement = {
        editIndex: i,
        start: occ.start,
        length: occ.length,
        newText: finalizeNewText(edit.newText, hit),
        kind: space,
      };
      if (!isNoOpReplacement(matchSpace, rep)) candidates.push(rep);
    };

    if (edit.replaceAll) {
      for (const occ of occurrences) addCandidate(occ);
      replacements.push(...candidates);
      outcomes.push({ editIndex: i, status: candidates.length > 0 ? "applied" : "no-op", hits });
      continue;
    }

    if (occurrences.length > 1) {
      if (edit.anchor) {
        const anchorLines = findAnchorLines(content, edit.anchor);
        if (anchorLines.length > 0) {
          const chosen = nearestOccurrence(occurrences, anchorLines, matchSpace);
          if (chosen) {
            addCandidate(chosen);
            replacements.push(...candidates);
            outcomes.push({
              editIndex: i,
              status: candidates.length > 0 ? "applied" : "no-op",
              hits: [buildHit(content, space, chosen)],
            });
            continue;
          }
        }
      }
      outcomes.push({ editIndex: i, status: "ambiguous", hits });
      continue;
    }

    const occ = occurrences[0];
    if (occ) {
      addCandidate(occ);
      replacements.push(...candidates);
      outcomes.push({ editIndex: i, status: candidates.length > 0 ? "applied" : "no-op", hits });
    }
  }

  // Cross-edit overlap detection (offsets are in the same matchSpace).
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev && cur && prev.start + prev.length > cur.start) {
      outcomes.push({ editIndex: cur.editIndex, status: "ambiguous", hits: [] });
      const idx = replacements.indexOf(cur);
      if (idx >= 0) replacements.splice(idx, 1);
    }
  }

  // An insertion boundary strictly inside a replaced block has no meaningful
  // position — the anchor region is being rewritten. Reject just that edit
  // instead of letting it land somewhere it did not ask for.
  if (insertions.length > 0 && replacements.length > 0) {
    const spans = getLineSpans(matchSpace);
    const replaced = replacements.map((r) => replacementLineRange(spans, r));
    const blocked = new Set(
      insertions
        .filter((ins) => {
          const boundary = ins.beforeLine - 1; // 0-based line index
          return replaced.some((range) => range.startLine < boundary && boundary < range.endLine);
        })
        .map((ins) => ins.editIndex),
    );
    if (blocked.size > 0) {
      for (let i = insertions.length - 1; i >= 0; i--) {
        if (blocked.has(insertions[i].editIndex)) insertions.splice(i, 1);
      }
      for (const editIndex of blocked) {
        const at = outcomes.findIndex((o) => o.editIndex === editIndex);
        if (at >= 0) outcomes[at] = { editIndex, status: "ambiguous", hits: [] };
      }
    }
  }

  return { space, replacements, insertions, outcomes };
}

function nearestOccurrence(
  occurrences: RawOccurrence[],
  anchorLines: number[],
  matchSpace: string,
): RawOccurrence | undefined {
  let best: RawOccurrence | undefined;
  let bestDist = Infinity;
  for (const occ of occurrences) {
    const line = lineForOffset(matchSpace, occ.start);
    for (const al of anchorLines) {
      const dist = Math.abs(line - al);
      if (dist < bestDist) {
        bestDist = dist;
        best = occ;
      }
    }
  }
  return best;
}

// ── Application (preserve original bytes outside touched line groups) ──────

/**
 * Apply replacements to content. Replacements are matched against `matchSpace`
 * (from PlanResult.space). For exact space, splice original content directly.
 * For normalized space, widen each replacement to whole lines, rewrite only
 * touched line groups from the normalized base, and copy all other lines
 * verbatim from the original — so untouched regions keep their original bytes.
 */
/** One edit's effect on the original bytes: replace [start, end) with text.
 * Insertions are zero-width (start === end). */
interface ApplyOp {
  start: number;
  end: number;
  text: string;
  /** Insertions sort before replacements at the same offset, so "insert before
   * line N" lands ahead of a replacement starting at line N. */
  rank: number;
  /** Plan order, preserved among ops at the same offset. */
  order: number;
}

/** Byte offset of the 1-based line before which to insert (totalLines + 1 =
 * end of content). */
function lineStartOffset(content: string, beforeLine: number): number {
  const spans = getLineSpans(content);
  const idx = beforeLine - 1;
  if (idx >= spans.length) return content.length;
  return spans[idx]?.start ?? 0;
}

/** Merge replacements into line-range groups, widening each to whole lines and
 * merging ones that touch the same lines (normalized-space rebuild unit). */
function groupReplacements(
  baseLines: LineSpan[],
  replacements: PlannedReplacement[],
): Array<{ startLine: number; endLine: number; reps: PlannedReplacement[] }> {
  const groups: Array<{ startLine: number; endLine: number; reps: PlannedReplacement[] }> = [];
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  for (const r of sorted) {
    const range = replacementLineRange(baseLines, r);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.reps.push(r);
    } else {
      groups.push({ ...range, reps: [r] });
    }
  }
  return groups;
}

/**
 * Apply a plan's replacements and insertions in one pass over the original
 * bytes. Insertions become zero-width ops at their line start; replacements
 * become byte-range ops (exact space) or whole-line-group ops (normalized
 * space, rebuilt from the normalized base). Untouched bytes are copied
 * verbatim either way.
 */
export function applyPreservingOriginal(content: string, plan: PlanResult): string {
  const { replacements, insertions } = plan;
  if (replacements.length === 0 && insertions.length === 0) return content;

  const ops: ApplyOp[] = [];
  let order = 0;

  if (plan.space === "exact") {
    for (const r of replacements) {
      ops.push({ start: r.start, end: r.start + r.length, text: r.newText, rank: 1, order: order++ });
    }
  } else if (replacements.length > 0) {
    const baseContent = normalizeForFuzzyMatch(content);
    const originalSpans = getLineSpans(content);
    const baseLines = getLineSpans(baseContent);
    if (originalSpans.length !== baseLines.length) {
      // Line-count divergence (normalization preserves it); splice the
      // normalized base and fall back to line-based insertions.
      const replaced = spliceBase(baseContent, replacements);
      return insertions.length > 0 ? applyInsertions(replaced, insertions) : replaced;
    }
    for (const group of groupReplacements(baseLines, replacements)) {
      const groupStartOffset = baseLines[group.startLine]?.start ?? 0;
      const groupEndOffset = baseLines[group.endLine - 1]?.end ?? groupStartOffset;
      const slice = baseContent.slice(groupStartOffset, groupEndOffset);
      const text = spliceBase(
        slice,
        group.reps.map((r) => ({ ...r, start: r.start - groupStartOffset })),
      );
      const start = originalSpans[group.startLine]?.start ?? content.length;
      const end =
        group.endLine < originalSpans.length ? (originalSpans[group.endLine]?.start ?? content.length) : content.length;
      ops.push({ start, end, text, rank: 1, order: order++ });
    }
  }

  for (const ins of insertions) {
    const at = lineStartOffset(content, ins.beforeLine);
    ops.push({
      start: at,
      end: at,
      text: ins.newText.endsWith("\n") ? ins.newText : `${ins.newText}\n`,
      rank: 0,
      order: order++,
    });
  }

  ops.sort((a, b) => a.start - b.start || a.rank - b.rank || a.order - b.order);

  let out = "";
  let cursor = 0;
  for (const op of ops) {
    out += content.slice(cursor, op.start);
    if (op.end > op.start) {
      out += op.text;
      cursor = op.end;
    } else {
      // Appending past a file with no trailing newline needs a separator;
      // out.endsWith also covers several insertions at the same end position.
      if (op.start === content.length && content.length > 0 && !out.endsWith("\n") && !op.text.startsWith("\n")) {
        out += "\n";
      }
      out += op.text;
      cursor = op.start;
    }
  }
  out += content.slice(cursor);
  return out;
}

/**
 * Apply insertions to original content by splicing each block at its line
 * boundary. Pure line-based: works identically regardless of match space
 * (insert-only plans have no normalized-space rebuild). Each insertion's
 * newText is treated as complete lines (terminated with \n); appends at end
 * get a separating newline when the last file line lacks one.
 */
function applyInsertions(content: string, insertions: PlannedInsertion[]): string {
  if (insertions.length === 0) return content;
  const lines = splitLinesWithEndings(content);
  const total = lines.length;
  // Group chunks by beforeLine, preserving plan order (editIndex then occurrence).
  const byLine = new Map<number, string[]>();
  for (const ins of insertions) {
    const arr = byLine.get(ins.beforeLine);
    if (arr) arr.push(ins.newText);
    else byLine.set(ins.beforeLine, [ins.newText]);
  }
  const emit = (beforeLine: number): string => {
    const chunks = byLine.get(beforeLine);
    if (!chunks) return "";
    return chunks.map((c) => (c.endsWith("\n") ? c : `${c}\n`)).join("");
  };
  let out = "";
  for (let i = 0; i < total; i++) {
    out += emit(i + 1);
    out += lines[i] ?? "";
  }
  const tail = emit(total + 1);
  if (tail) {
    if (total > 0 && !lines[total - 1].endsWith("\n") && !tail.startsWith("\n")) out += "\n";
    out += tail;
  }
  return out;
}

function replacementLineRange(baseLines: LineSpan[], r: PlannedReplacement): { startLine: number; endLine: number } {
  let startLine = 0;
  for (let i = 0; i < baseLines.length; i++) {
    if (r.start >= baseLines[i].start && r.start < baseLines[i].end) {
      startLine = i;
      break;
    }
  }
  let endLine = startLine;
  while (endLine < baseLines.length && baseLines[endLine].end < r.start + r.length) {
    endLine++;
  }
  return { startLine, endLine: endLine + 1 };
}

function spliceBase(base: string, reps: PlannedReplacement[]): string {
  const sorted = [...reps].sort((a, b) => b.start - a.start);
  let result = base;
  for (const r of sorted) {
    result = result.slice(0, r.start) + r.newText + result.slice(r.start + r.length);
  }
  return result;
}
