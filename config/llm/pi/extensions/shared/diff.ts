/**
 * Diff primitives shared across extensions.
 *
 * Two layers:
 * - `diffRunes` — char-level LCS diff between two single lines, grouped into
 *   contiguous differing hunks. Extracted from `patch/diagnostics.ts` so the
 *   exact-codepoint diagnostics and the caller-warning module share one LCS.
 * - `changedLineNumbers` — line-level LCS diff between two file contents,
 *   returning the NEW-side line numbers that differ. Used by the LSP caller
 *   warning to decide which top-level symbols an edit touched.
 * - `diffLineCounts` — added/removed counts read off pi's display-format diff
 *   (`+12 text`), for stating an edit's size in a classifier's state.
 *
 * All are pure (no pi imports) and bun-testable. Matching concerns (tolerant
 * normalization, indentation) deliberately live in patch/match.ts, not here —
 * these are exact-content diffs used for diagnosis / change-detection, not for
 * deciding whether to apply an edit.
 */

/** A single contiguous differing hunk between two lines. `expected` is from
 * oldText, `actual` from the file. Either may be empty (pure insert/delete). */
export interface CharDiff {
  expected: string;
  actual: string;
}

/** Cap LCS table size; longer lines fall back to common prefix/suffix (still
 * informative, avoids O(n*m) blowup on minified/very-long lines). */
const MAX_LCS_LEN = 400;

/** Char-level diff between two lines, grouped into contiguous differing hunks.
 * Uses a bounded LCS so the common case (one substituted/inserted/deleted rune)
 * is reported precisely — including invisible Unicode. Diagnosis only. */
export function diffRunes(a: string, b: string): CharDiff[] {
  if (a === b) return [];
  const aa = Array.from(a);
  const bb = Array.from(b);
  if (aa.length > MAX_LCS_LEN || bb.length > MAX_LCS_LEN) {
    const span = prefixSuffixSpan(aa, bb);
    return span ? [span] : [];
  }
  return lcsHunks(aa, bb);
}

/** Common-prefix/suffix fallback: the single span between the shared ends.
 * The suffix bound is independent of `pre` (pre + suf can exceed half the
 * string), so a difference at the center of equal-length strings is found. */
function prefixSuffixSpan(aa: string[], bb: string[]): CharDiff | null {
  let pre = 0;
  const minPre = Math.min(aa.length, bb.length);
  while (pre < minPre && aa[pre] === bb[pre]) pre++;
  let suf = 0;
  while (suf < aa.length - pre && suf < bb.length - pre && aa[aa.length - 1 - suf] === bb[bb.length - 1 - suf]) suf++;
  const expected = aa.slice(pre, aa.length - suf).join("");
  const actual = bb.slice(pre, bb.length - suf).join("");
  if (expected === "" && actual === "") return null;
  return { expected, actual };
}

/** LCS-based diff → list of differing hunks (adjacent del+ins coalesced into
 * one substitution hunk). Splits by code point (Array.from) so surrogate
 * pairs/emoji aren't torn apart. */
function lcsHunks(aa: string[], bb: string[]): CharDiff[] {
  const m = aa.length;
  const n = bb.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  const at = (i: number, j: number) => i * (n + 1) + j;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[at(i, j)] = aa[i] === bb[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const hunks: CharDiff[] = [];
  let exp = "";
  let act = "";
  const flush = () => {
    if (exp !== "" || act !== "") {
      hunks.push({ expected: exp, actual: act });
      exp = "";
      act = "";
    }
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aa[i] === bb[j]) {
      flush();
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      exp += aa[i];
      i++;
    } else {
      act += bb[j];
      j++;
    }
  }
  while (i < m) {
    exp += aa[i];
    i++;
  }
  while (j < n) {
    act += bb[j];
    j++;
  }
  flush();
  return hunks;
}

// ── Line-level diff (which file lines changed) ─────────────────────────────

/** Cap for the line-level LCS DP cells; larger inputs fall back to treating
 * the whole middle as changed. The caller-warning consumer caps the number of
 * touched symbols and callers downstream, so over-reporting is bounded noise. */
const MAX_LINE_LCS_CELLS = 4_000_000;

/** Split content into lines (a trailing newline does not add an empty line). */
export function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * NEW-side 1-based line numbers that differ between oldContent and newContent.
 *
 * A line is "changed" if it is not matched to an old line in the LCS — i.e.
 * it is inserted or part of a substitution. Deleted old lines don't map to a
 * concrete new line, but the surrounding shift shows up as changed new lines;
 * for the caller-warning use (find which top-level symbols an edit touched)
 * this leans toward over-reporting, which is then bounded by the caps. Returns
 * [] when the contents are identical.
 */
export function changedLineNumbers(oldContent: string, newContent: string): number[] {
  if (oldContent === newContent) return [];
  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);

  // Trim the common prefix/suffix so the LCS only runs on the changed middle.
  let pre = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (pre < minLen && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  ) {
    suf++;
  }

  const oMid = oldLines.slice(pre, oldLines.length - suf);
  const nMid = newLines.slice(pre, newLines.length - suf);
  if (oMid.length === 0 && nMid.length === 0) return [];

  let changed: number[];
  if (oMid.length * nMid.length <= MAX_LINE_LCS_CELLS) {
    const at = (i: number, j: number) => i * (nMid.length + 1) + j;
    changed = changedNewIndices(oMid, nMid, (a, b) => at(a, b));
  } else {
    // Oversize: treat every middle line as changed (over-report, bounded later).
    changed = nMid.map((_, k) => k);
  }

  // Middle-relative (0-based) → overall 1-based new-file line numbers.
  return changed.map((k) => pre + k + 1);
}

/** New-side middle indices that are NOT matched into the LCS. Tie-break favors
 * advancing old (delete) on equal counts, so the matched set is stable. `at`
 * is the caller's index function so the stride stays consistent. */
function changedNewIndices(a: string[], b: string[], at: (i: number, j: number) => number): number[] {
  // Compute the DP table for the middle (bounded by the caller's size check).
  const m = a.length;
  const n = b.length;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }

  const changed: number[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      i++;
    } else {
      changed.push(j);
      j++;
    }
  }
  while (j < n) {
    changed.push(j);
    j++;
  }
  return changed;
}

// ── Display-diff line counts ────────────────────────────────────────────────

/**
 * Added and removed lines in one pi-format diff (`+12 text` / `-12 text`). Each
 * line is classified by its own leading marker, so a content line that starts
 * with `+`/`-` after its line number is still counted by the marker.
 *
 * Callers must pass a single file's diff: `patch` joins multi-file previews with
 * a `--- <path> ---` separator, which would count as one removed line.
 */
export function diffLineCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** "1 line", "40 lines". */
export function pluralLines(n: number): string {
  return `${n} ${n === 1 ? "line" : "lines"}`;
}
