# patch

A forgiving file edit tool: tolerant matching (whitespace/Unicode drift, literal
escape sequences), a note of how each edit matched, and diagnostics when it fails.

## Why

The built-in `edit` fails on invisible-byte differences (Unicode arrows,
tab↔space, indentation drift) and gives opaque diagnostics ("Could not find the
exact text"). That costs agent turns: a single failed edit cuts recovery
probability by a third (SWE-agent, NeurIPS 2024).

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
that was not byte-exact is never silent.

**Diagnostics** — on failure, returns the closest match with similarity % and line
number, plus a per-line codepoint breakdown naming the differing characters
(invisible Unicode: NBSP, zero-width space, em-dash vs `--`). Three rendering
tiers: printable ASCII → bare literal; non-ASCII visible → glyph + U+XXXX;
invisible whitespace/zero-width → named (e.g. `NON-BREAKING SPACE (U+00A0)`). For
the top candidate at ≥90% similarity the full window is printed instead of a
4-line preview — same line count as oldText, so it can be pasted back as a
corrected `oldText`. When several exact matches exist, normalized-equal
occurrences with different whitespace are reported as well. The whole call is
validated before anything is written; every failure is reported so one retry can
fix all of them.

**Disambiguation** — `anchor` (a unique nearby string, self-validating) picks
the right occurrence; `replaceAll` for all of them. No line numbers required
(models are bad at counting).

**Multi-file** — set `path` per-edit to target different files; atomic across
all via nested `withFileMutationQueue`.

**dryRun** — preview matches + diff without writing.

**Insert modes** — `mode: "insertAfter"` / `"insertBefore"` treat `oldText` as a
unique anchor and splice `newText` (new content only) at a line boundary
after/before it. The anchor is never re-emitted, so its bytes and indentation stay
untouched, and newText is inserted verbatim. Insert and replace edits mix in one
call (an insertion whose boundary falls inside a replaced block is rejected rather
than guessed at). Supports `anchor`/`replaceAll` like replace. A duplicate-line
guard flags newText that re-includes the anchor; opt out per-edit with
`allowAnchorRepeat: true` for the "repeat and extend" idiom.

**Diff-as-result** — a successful edit returns the full diff in the result text,
plus the line each edit landed on (`edits[N] → line X`, with an `(anchored)` tag
when an anchor disambiguated among near-identical sites), under a per-file header
naming the match strategy.

**No-op detection** — an edit whose `oldText` and `newText` are identical (a
common paste-the-same-thing-on-both-sides typo) fails the batch atomically instead
of counting as applied.

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
  rewrite only touched line groups; all other lines keep their original bytes,
  so Unicode in untouched regions is never mangled.
- **Atomic application.** Validate-all-first; if any edit fails, nothing is
  written across any file.
- **No staleness gate.** `oldText` is the consistency check; the per-file
  mutation queue handles concurrent edits. A gate would false-positive on a
  formatter touching an unrelated region.

## Permission gate integration

The permission gate confirms only when the preview succeeds — all edits matched
and a real write is pending. Failed previews and `dryRun` skip the prompt; their
diagnostics surface on their own.

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
  replaceAll, overlap detection, byte preservation, insert modes). No pi imports.
- `diagnostics.ts` — pure diagnostics (closest match, char-level codepoint diff via
  bounded LCS, three-tier rune rendering, occurrence context with `>>` markers,
  near-miss detection, duplicate-line guard, message formatting).
- `preview.ts` — diff preview for the permission gate (uses patch's own
  matcher, not pi's computeEditsDiff).
- `match.test.ts` / `diagnostics.test.ts` — tests covering a matrix of whitespace,
  Unicode, indentation and stale-context inputs, plus each feature above,
  including codepoint-level char-diff and three-tier rendering.
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
