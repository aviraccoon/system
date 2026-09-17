# patch

A more forgiving file edit tool. Tolerant matching (whitespace/Unicode drift,
literal escape sequences) reports how it matched, and gives rich diagnostics on
failure.

## Why

The built-in `edit` fails on invisible-byte differences (Unicode arrows,
tab↔space, indentation drift) and gives opaque diagnostics on failure ("Could
not find the exact text"). This burns agent turns — a single failed edit cuts
recovery probability by a third (SWE-agent NeurIPS 2024 data).

## What's different

**Matching** — a cascade, strictest first (consensus across Codex, OpenCode,
Octofs):
1. Exact whole-string match (tried first — zero cost when the model is precise)
2. Normalized fuzzy match (arrows → ASCII, tab↔space, smart quotes/dashes,
   special spaces, trailing whitespace, internal whitespace runs) with
   indentation auto-adjust
3. Literal escape sequences (`\n`, `\t`) interpreted as characters — tried when
   the raw oldText finds nothing, in that same match space (exact or normalized),
   and reported when it is what matched
4. Closest-match diagnostics (never applies — just reports)

**Match receipt** — a successful edit reports how it matched, per file:
`(match: exact)` or `(match: tolerant (whitespace/Unicode/tab differences
normalized))`, with the tolerance named when escapes were interpreted. A write
that was not byte-exact is never silent, so the agent can verify placement
instead of assuming.

**Diagnostics** — on failure, returns the closest match with similarity % and
line number, plus a **per-line codepoint breakdown** naming the exact differing
characters (especially invisible Unicode: NBSP, zero-width space, em-dash vs
`--`). Three rendering tiers: printable ASCII → bare literal; non-ASCII visible
→ glyph + U+XXXX; invisible whitespace/zero-width → named (e.g.
`NON-BREAKING SPACE (U+00A0)`). For the top candidate at ≥90% similarity the
**full window text is printed** (not a 4-line preview) — it has the same line
count as oldText, so it is a copy-pasteable corrected `oldText`. When multiple
exact matches exist, also reports **normalized-equal occurrences** with
different whitespace (near-misses the exact match missed). All edits in a call
are validated before any file is written (atomic), and every failure is reported
so the model fixes all in one retry.

**Disambiguation** — `anchor` (a unique nearby string, self-validating) picks
the right occurrence; `replaceAll` for all of them. No line numbers required
(models are bad at counting).

**Multi-file** — set `path` per-edit to target different files; atomic across
all via nested `withFileMutationQueue`.

**dryRun** — preview matches + diff without writing.

**Insert modes** — `mode: "insertAfter"` / `"insertBefore"` treat `oldText` as a
unique anchor and splice `newText` (new content only) at a line boundary
after/before the matched block. The anchor is never re-emitted from newText, so
its bytes and indentation are preserved byte-for-byte and there is no
indentation-drift surface — this is the structural fix for the "paste the anchor
into both oldText and newText" footgun that `replace` invites. newText is
inserted verbatim (no auto-indent). Insert and replace edits mix in one call
(an insertion whose boundary falls inside a replaced block is rejected rather
than guessed at). Supports `anchor`/`replaceAll` like replace. A
duplicate-line guard flags newText that re-includes the anchor; opt out per-edit
with `allowAnchorRepeat: true` for the legitimate "repeat and extend" idiom.

**Diff-as-result** — successful edits return the full diff in the result
text (for LLM self-verification), plus the line each edit landed on
(`edits[N] → line X`, with an `(anchored)` tag when an anchor disambiguated
among near-identical sites), under a per-file header that names the match
strategy. Not just the TUI.

**No-op detection** — an edit whose `oldText` and `newText` are identical (a
common paste-the-same-thing-on-both-sides typo) is flagged as a no-op and
fails the batch atomically, instead of silently counting as applied. Catches
the failure that inflates the applied-count and hides what actually changed.

**Duplicate-line guard** — detects when the model includes surrounding unchanged
lines in its replacement (would silently double on disk).

## Parameters

| Param | Required | Description |
|-------|----------|-------------|
| `path` | yes (top-level) | File to edit; overridden per-edit |
| `edits[]` | yes | `{ oldText, newText, path?, anchor?, replaceAll?, mode?, allowAnchorRepeat? }` |
| `dryRun` | no | Report without writing |

## Correctness invariants

- **Original bytes preserved.** Normalized matches widen to whole lines and
  rewrite only touched line groups; all other lines keep their original bytes.
  Unicode in untouched regions is never mangled.
- **Atomic application.** Validate-all-first; if any edit fails, nothing is
  written across any file.
- **No staleness gate.** `old_string` is the consistency check; the per-file
  mutation queue handles concurrent edits. A gate would cause false positives
  (formatter touches an unrelated region → forced re-read).

## Permission gate integration

The permission gate skips confirmation for doomed edits (preview fails, edits
don't match) and `dryRun` — the tool will throw diagnostics naturally, no
point asking the user to approve. Only shows the confirm dialog when the
preview succeeds (all edits matched, a real write is pending).

## Name table contract

The invisible-name table (`NAMED_CODEPOINTS` in `diagnostics.ts`) covers only
zero-width/format chars and space-variants — codepoints whose literal glyph is
blank or absent. Visible codepoints (×, em-dash, smart quotes, arrows, …) are
shown as glyph + U+XXXX with no human name: enough to act on, no drift risk
from a growing normalization ↔ names table.

If `match.ts` grows a new **invisible** normalization, add its name here;
forgetting only degrades the message to `whitespace (U+XXXX)`, never to a wrong
match.

## Files

- `match.ts` — pure matching engine (cascade, escape tolerance, anchor,
  replaceAll, overlap detection, byte preservation, **insert modes**). No pi
  imports.
- `diagnostics.ts` — pure diagnostics (closest match, **char-level codepoint
  diff** via bounded LCS, three-tier rune rendering, occurrence context with `>>`
  markers, near-miss detection, duplicate-line guard, message formatting). No pi
  imports.
- `preview.ts` — diff preview for the permission gate (uses patch's own
  matcher, not pi's computeEditsDiff).
- `match.test.ts` / `diagnostics.test.ts` — tests covering the HarnessKit
  matrix (whitespace, Unicode, indentation, stale context) plus anchor,
  replaceAll, overlap, byte-preservation, duplicate-line guard, near-miss
  detection, no-op detection, escape tolerance, and **codepoint-level char-diff /
  three-tier rendering**.
- `index.ts` — pi integration shell (tool registration, multi-file via nested
  withFileMutationQueue, atomic validate-all-first, path auto-lift, dryRun,
  post-exec diff, live preview in renderCall, self-contained error messages).

## Related

- `shared/edit-tools.ts` — `EDIT_LIKE_TOOLS` + `collectToolPaths` for wiring
  patch into sibling extensions (LSP diagnostics, permission gate, agents-loader).
- `permission-gate` — diff preview uses `patch/preview.ts` for accurate
  tolerant-matching previews.
- `lsp/index.ts` — runs diagnostics after patch edits (LSP warnings/errors
  appended to tool result).
