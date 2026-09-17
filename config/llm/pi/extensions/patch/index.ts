/**
 * patch — a more forgiving file edit tool.
 *
 * Three-stage matching (exact → normalized → closest-match diagnostics),
 * anchor-based disambiguation, replaceAll, multi-file, dryRun, and rich
 * diagnostics. All matching logic is in match.ts / diagnostics.ts (pure, no pi
 * imports, fully tested). This file is the thin pi integration shell.
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { generateDiffString, renderDiff, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { findDuplicationIssues, formatOutcomes } from "./diagnostics";
import {
  applyPreservingOriginal,
  detectLineEnding,
  type Edit,
  type EditOutcome,
  normalizeToLF,
  type PlanResult,
  planAll,
  restoreLineEndings,
  stripBom,
} from "./match";
import { computePatchPreview, type PatchPreview } from "./preview";

// ── Schema ─────────────────────────────────────────────────────────────────

const editSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text to replace. Matching is tolerant: it also accepts normalized variants (arrows → ASCII, tab↔space, smart quotes/dashes, trailing whitespace). Must be unique unless anchor/replaceAll is used.",
    }),
    newText: Type.String({
      description:
        "Replacement text. Your newText (including its indentation) replaces the matched block — copy the exact indentation you want to see. Indentation is auto-adjusted to the file only when the matched block shares one indent level; for mixed-indent blocks (e.g. a function signature plus its indented body, or a numbered list) newText's indentation is used verbatim.",
    }),
    path: Type.Optional(
      Type.String({ description: "File path for this edit. Overrides the top-level path (multi-file)." }),
    ),
    anchor: Type.Optional(
      Type.String({
        description:
          "Unique nearby text. When oldText matches multiple times, the occurrence nearest this anchor is used. Self-validating — copy a real string from the file.",
      }),
    ),
    replaceAll: Type.Optional(Type.Boolean({ description: "Replace every occurrence of oldText (default false)." })),
    mode: Type.Optional(
      Type.Union([Type.Literal("replace"), Type.Literal("insertAfter"), Type.Literal("insertBefore")], {
        description:
          'How to apply. "replace" (default): newText rewrites the matched block. "insertAfter"/"insertBefore": oldText is a unique anchor; newText is the NEW content spliced at the line boundary after/before the anchor. The anchor stays in the file byte-for-byte — do NOT repeat it inside newText (the duplicate-line guard rejects this). newText is inserted verbatim with no auto-indent (no indentation-drift risk). Use the minimum unique anchor (one line if unique); multi-line anchors push insertion past the target — insertAfter lands after the LAST matched line, insertBefore before the FIRST. Anchor on a real block boundary: insertAfter on the first line of a multi-line paragraph splits it mid-sentence — to insert between blocks, anchor the last line of the preceding block (insertAfter) or the first line of the following block (insertBefore). Never use replace with the first line of a longer block when you mean to insert — replace consumes the anchor line. Insert and replace edits may be mixed in one call; an insertion whose anchor falls inside a replaced block is rejected rather than guessed at. Example: to add a status line after a header, oldText="### Header", newText="**Status:** ..." — newText contains only the new line, not the anchor.',
      }),
    ),
    allowAnchorRepeat: Type.Optional(
      Type.Boolean({
        description:
          'Insert-only. Allow newText to repeat the anchor line (default false). Set true for the legitimate "repeat and extend" idiom (e.g. append a line that happens to match the anchor). Ignored for replace.',
      }),
    ),
  },
  { additionalProperties: false },
);

const patchSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute). Can also be set per-edit." }),
    edits: Type.Array(editSchema, {
      description:
        "One or more replacements. All edits are validated before any file is written (atomic). If any edit fails, nothing is written and every failure is reported so you can fix them all in one retry.",
    }),
    dryRun: Type.Optional(
      Type.Boolean({
        description:
          "If true, report what would change without writing. Returns match status, occurrences, and a preview diff.",
      }),
    ),
  },
  { additionalProperties: false },
);

// ── Argument preparation (path auto-lift + legacy fold) ───────────────────

interface EditArg {
  oldText?: string;
  newText?: string;
  path?: string;
  anchor?: string;
  replaceAll?: boolean;
}

interface PatchArgs {
  path?: string;
  edits?: EditArg[];
  oldText?: string;
  newText?: string;
  dryRun?: boolean;
}

/** Shape returned by prepareArguments (validated by the schema after). */
type PreparedArgs = {
  path: string;
  edits: { oldText: string; newText: string; path?: string; anchor?: string; replaceAll?: boolean }[];
  dryRun?: boolean;
};

/**
 * Lifts a `path` accidentally nested inside edits[] up to the top level, and
 * folds the legacy single-edit shape (top-level oldText/newText) into edits[].
 * Models frequently mis-place path.
 */
function prepareArguments(input: unknown): PreparedArgs {
  if (!input || typeof input !== "object") return input as PreparedArgs;
  const args = { ...(input as PatchArgs) };

  // Parse stringified edits (some models send JSON strings).
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed as EditArg[];
    } catch {
      /* keep as-is */
    }
  }

  // Legacy single-edit fold: top-level oldText/newText → edits[0].
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    args.edits = [...edits, { oldText: args.oldText, newText: args.newText }];
    delete args.oldText;
    delete args.newText;
  }

  // Path auto-lift: if path only present inside edits, lift the first one.
  if (typeof args.path !== "string" && Array.isArray(args.edits)) {
    const nested = args.edits.find((e) => typeof e?.path === "string");
    if (nested?.path) args.path = nested.path;
  }

  // Cast loosely: the schema re-validates oldText/newText/path after this runs.
  return args as unknown as PreparedArgs;
}

// ── Path resolution ────────────────────────────────────────────────────────

function resolvePath(rawPath: string, cwd: string): string {
  const stripped = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return resolve(cwd, stripped);
}

// ── Per-file processing ────────────────────────────────────────────────────

interface FileResult {
  displayPath: string;
  newContent: string;
  diff: string;
  firstChangedLine: number | undefined;
  /** Distinct edits applied to this file. */
  editCount: number;
  /** Total occurrences replaced (editCount counts replaceAll as one edit). */
  occurrenceCount: number;
  /** Where each applied edit landed (1-based lines), for verification.
   * Especially important for anchored edits: a mis-targeted match would
   * otherwise only surface in a possibly-truncated diff. */
  appliedLocations: Array<{
    editIndex: number;
    lines: number[];
    anchored: boolean;
    insert?: "insertAfter" | "insertBefore";
  }>;
  /** How the batch matched, for the success receipt: "exact" or a tolerant
   * description. Agents should be told when a write was not byte-exact. */
  strategy: string;
}

interface FileFailure {
  displayPath: string;
  messages: string[];
}

function groupByFile(
  edits: Edit[],
  topLevelPath: string,
  cwd: string,
): Map<string, { displayPath: string; edits: Edit[] }> {
  const groups = new Map<string, { displayPath: string; edits: Edit[] }>();
  for (const edit of edits) {
    const rawPath = edit.path ?? topLevelPath;
    const abs = resolvePath(rawPath, cwd);
    const existing = groups.get(abs);
    if (existing) {
      existing.edits.push(edit);
    } else {
      groups.set(abs, { displayPath: rawPath, edits: [edit] });
    }
  }
  return groups;
}

interface ProcessOutcome {
  results: FileResult[];
  failures: FileFailure[];
}

/** Read + plan all files. Does NOT write — caller writes only if no failures. */
async function planFiles(groups: Map<string, { displayPath: string; edits: Edit[] }>): Promise<ProcessOutcome> {
  const results: FileResult[] = [];
  const failures: FileFailure[] = [];

  for (const [absPath, { displayPath, edits }] of groups) {
    let buffer: Buffer;
    try {
      buffer = await readFile(absPath);
    } catch (error) {
      const msg = error instanceof Error && "code" in error ? `Error code: ${String(error.code)}` : String(error);
      failures.push({ displayPath, messages: [`Could not read file: ${displayPath}. ${msg}`] });
      continue;
    }

    const rawContent = buffer.toString("utf-8");
    const { bom, text } = stripBom(rawContent);
    const ending = detectLineEnding(text);
    const content = normalizeToLF(text);

    const plan = planAll(content, edits);
    const messages: string[] = [];

    // Duplicate-line guard on each applied replacement + insert duplication.
    // Uses the shared findDuplicationIssues so the same checks run in the
    // preview (preview.ts) — adding a new guard here automatically covers both.
    for (const issue of findDuplicationIssues(content, plan, edits)) {
      messages.push(issue.message);
    }

    messages.push(...formatOutcomes(content, plan, edits));

    if (messages.length > 0 || (plan.replacements.length === 0 && plan.insertions.length === 0)) {
      failures.push({
        displayPath,
        messages: messages.length > 0 ? messages : ["No matching edits — nothing to apply."],
      });
      continue;
    }

    const newContent = applyPreservingOriginal(content, plan);
    // No-net-change guard: every edit matched but newText produces identical
    // content (e.g. oldText === newText, or newText differs texturally but
    // normalizes to the same bytes). Without this, the tool reports a false
    // success — the exact "misleading it-worked" failure patch exists to prevent.
    if (newContent === content) {
      failures.push({
        displayPath,
        messages: [
          "The edits produced no change: newText is identical to oldText (after normalization) for every edit. Nothing was written. If you intended a change, verify oldText and newText actually differ.",
        ],
      });
      continue;
    }
    const { diff, firstChangedLine } = generateDiffString(content, newContent);
    const appliedOutcomes = plan.outcomes.filter(
      (o): o is Extract<EditOutcome, { status: "applied" }> => o.status === "applied",
    );
    const appliedLocations: FileResult["appliedLocations"] = [];
    for (const o of appliedOutcomes) {
      const edit = edits[o.editIndex];
      const mode = edit?.mode;
      if (mode === "insertAfter" || mode === "insertBefore") {
        for (const ins of plan.insertions) {
          if (ins.editIndex !== o.editIndex) continue;
          appliedLocations.push({
            editIndex: o.editIndex,
            lines: [ins.beforeLine],
            anchored: ins.anchored,
            insert: mode,
          });
        }
      } else {
        appliedLocations.push({
          editIndex: o.editIndex,
          lines: o.hits.map((h) => h.line),
          anchored: Boolean(edit?.anchor),
        });
      }
    }
    results.push({
      displayPath,
      newContent: bom + restoreLineEndings(newContent, ending),
      diff,
      firstChangedLine,
      editCount: appliedOutcomes.length,
      occurrenceCount: plan.replacements.length + plan.insertions.length,
      appliedLocations,
      strategy: matchStrategyLabel(plan),
    });
  }

  return { results, failures };
}

/** Acquire all file queues (nested) for atomic multi-file mutation. */
async function withQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  if (paths.length === 0) return fn();
  const [first, ...rest] = paths;
  if (!first) return fn();
  return withFileMutationQueue(first, () => withQueues(rest, fn));
}

function formatLocations(r: FileResult): string {
  if (r.appliedLocations.length === 0) return "";
  // Surface where each edit landed — most valuable when an anchor picked
  // among near-identical sites, where a mis-target would otherwise only
  // surface in a re-grep. Line numbers are 1-based.
  return r.appliedLocations
    .map((loc) => {
      const tag = loc.anchored ? " (anchored)" : "";
      if (loc.insert) {
        return `  edits[${loc.editIndex}] → ${loc.insert} before line ${loc.lines[0]}${tag}`;
      }
      return `  edits[${loc.editIndex}] → line${loc.lines.length === 1 ? "" : "s"} ${loc.lines.join(", ")}${tag}`;
    })
    .join("\n");
}

function buildSuccessText(results: FileResult[]): string {
  const edits = results.reduce((sum, r) => sum + r.editCount, 0);
  const occurrences = results.reduce((sum, r) => sum + r.occurrenceCount, 0);
  const tolerant = results.filter((r) => r.strategy !== "exact").length;
  const header =
    `Applied ${edits} edit(s) (${occurrences} occurrence(s)) across ${results.length} file(s). Files written.` +
    (tolerant > 0
      ? ` ${tolerant} file(s) matched tolerantly, not byte-exact — check that the change landed where you meant it.`
      : "");
  const parts = results.map((r) => {
    const locs = formatLocations(r);
    const head = `--- ${r.displayPath} --- (match: ${r.strategy})`;
    return locs ? `${head}\n${locs}\n${r.diff}` : `${head}\n${r.diff}`;
  });
  return [header, ...parts].join("\n\n");
}

/** Human label for how a batch matched; "exact" when it was byte-exact. */
function matchStrategyLabel(plan: PlanResult): string {
  const base = plan.space === "exact" ? "exact" : "tolerant (whitespace/Unicode/tab differences normalized)";
  return plan.unescaped ? `${base}; literal \\n/\\t escapes interpreted as characters` : base;
}

// ── Live diff preview (renderCall) ──────────────────────────────────────────
// Ports the built-in `edit` tool's streaming preview so the diff shows in the
// chat BEFORE the permission gate fires (the user wants to see it in main chat,
// not only in the gate dialog). Uses patch's OWN matcher (computePatchPreview)
// so normalized matches (arrows, tab↔space) preview correctly — pi's
// computeEditsDiff would show nothing for those.

interface PatchCallComponent extends Box {
  preview?: { diff: string } | { error: string } | undefined;
  previewArgsKey?: string;
  previewPending?: boolean;
}

function getPatchCallComponent(state: Record<string, unknown>, lastComponent: unknown): PatchCallComponent {
  if (lastComponent instanceof Box) {
    const component = lastComponent as PatchCallComponent;
    state.callComponent = component;
    return component;
  }
  const cached = state.callComponent as PatchCallComponent | undefined;
  if (cached) return cached;
  const component = new Box(0, 0, (t) => t) as PatchCallComponent;
  state.callComponent = component;
  return component;
}

function patchCallLabel(args: { path?: unknown; edits?: unknown; dryRun?: unknown }, theme: Theme): string {
  const paths = new Set<string>();
  if (typeof args.path === "string") paths.add(args.path);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit.path === "string") paths.add(edit.path);
    }
  }
  const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
  const dryRun = args.dryRun === true;
  const label = theme.fg("toolTitle", theme.bold(dryRun ? "patch (dry run) " : "patch "));
  const pathStr = theme.fg("accent", [...paths].join(", "));
  const count = theme.fg("muted", ` (${editCount} edit${editCount !== 1 ? "s" : ""})`);
  return `${label}${pathStr}${count}`;
}

function buildPatchCallComponent(
  component: PatchCallComponent,
  args: Parameters<typeof patchCallLabel>[0],
  theme: Theme,
): PatchCallComponent {
  component.clear();
  component.addChild(new Text(patchCallLabel(args, theme), 0, 0));
  if (component.preview) {
    component.addChild(new Spacer(1));
    const body =
      "error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
    component.addChild(new Text(body, 0, 0));
  }
  return component;
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "patch",
    label: "Patch",
    description:
      "Edit one or more files using tolerant text replacement. USE THIS INSTEAD OF THE BUILT-IN EDIT TOOL FOR ALL FILE TYPES (code, markdown, config, prose). Matching accepts normalized variants (Unicode arrows/symbols → ASCII, tab↔space, smart quotes/dashes, trailing whitespace) so edits don't fail on invisible-byte differences. On failure, returns closest matches and occurrence line numbers so you can fix everything in one retry. Supports anchor-based disambiguation, replaceAll, multi-file edits, insert mode, and dryRun.",
    promptSnippet:
      "patch: ALWAYS use instead of edit. Tolerant matching (Unicode arrows, tab↔space, smart quotes normalized). Closest-match diagnostics on failure. Anchor disambiguation, replaceAll, multi-file, dryRun.",
    promptGuidelines: [
      "ALWAYS use patch instead of edit for ALL file edits — code, markdown, config, prose, every file type. There is no scenario where edit is preferred. patch has every capability edit has plus tolerant matching, better diagnostics, insert mode, multi-file atomicity, and anchor disambiguation. Using edit when patch exists wastes a retry when invisible-byte differences cause the edit to fail.",
      "Do not guess line numbers — patch has no line-based parameters. Use `anchor` (a unique nearby string) or `replaceAll` to disambiguate when oldText matches multiple times.",
      "Include only the lines being changed plus minimal context for uniqueness in oldText. Do not pad with surrounding unchanged lines — the duplicate-line guard rejects this.",
      'Prefer `mode: "insertAfter"`/`"insertBefore"` over replace-when-you-only-mean-to-add: insert cannot drift on indentation or invisible bytes.',
    ],
    parameters: patchSchema,
    prepareArguments,

    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const dryRun = input.dryRun === true;
      const edits = (input.edits ?? []) as Edit[];
      if (edits.length === 0) {
        throw new Error("patch requires at least one edit in edits[].");
      }
      const topLevelPath = input.path;
      if (typeof topLevelPath !== "string") {
        throw new Error("patch requires a top-level `path` (or set `path` inside each edit).");
      }

      const cwd = ctx.cwd;
      const groups = groupByFile(edits, topLevelPath, cwd);
      const paths = [...groups.keys()];

      const throwIfAborted = () => {
        if (signal?.aborted) throw new Error("Operation aborted");
      };

      const outcome = await withQueues(paths, async () => {
        throwIfAborted();
        const planned = await planFiles(groups);
        // Write under the queue: concurrent same-file patch calls must not
        // interleave writes. Holding the queue across plan+write means a second
        // caller's plan sees the first's write (its oldText may then cleanly
        // fail to match → retry) instead of both planning against the original
        // and writing unsynchronized. Atomicity preserved: nothing is written
        // unless every file's plan succeeded.
        if (planned.failures.length === 0 && !dryRun) {
          throwIfAborted();
          await writeResults(groups, planned.results, signal);
        }
        return planned;
      });

      if (outcome.failures.length > 0) {
        const totalFiles = groups.size;
        const failedFiles = outcome.failures.length;
        const allMessages = outcome.failures.flatMap((f) => f.messages.map((m) => `${f.displayPath}: ${m}`));
        throw new Error(
          [
            `patch failed: ${failedFiles} of ${totalFiles} file(s) had errors.`,
            "patch is atomic (all-or-nothing): it validates EVERY edit before writing any, so NONE were applied — including the edits that matched. The files are unchanged.",
            "Fix the errors below and call patch again with the corrected edits. Edits that already matched will match again on retry — you do not need to re-read the file.",
            "",
            ...allMessages,
          ].join("\n"),
        );
      }

      const text = buildSuccessText(outcome.results);
      const firstDiff = outcome.results[0]?.diff ?? "";
      const firstChangedLine = outcome.results[0]?.firstChangedLine;

      return {
        content: [{ type: "text" as const, text: dryRun ? `[dry run] ${text}` : text }],
        details: {
          diff: firstDiff,
          firstChangedLine,
          dryRun,
          fileCount: outcome.results.length,
        },
      };
    },

    renderCall(args, theme, context) {
      const component = getPatchCallComponent(context.state as Record<string, unknown>, context.lastComponent);
      const previewInput =
        typeof args.path === "string" && Array.isArray(args.edits)
          ? { path: args.path, edits: args.edits as Edit[] }
          : null;
      const argsKey = previewInput ? JSON.stringify(previewInput) : undefined;

      // New args → drop stale preview.
      if (component.previewArgsKey !== argsKey) {
        component.preview = undefined;
        component.previewArgsKey = argsKey;
        component.previewPending = false;
      }

      // Once args are complete, compute the diff asynchronously (reads files).
      if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
        component.previewPending = true;
        const requestKey = argsKey;
        void computePatchPreview(previewInput.path, previewInput.edits, context.cwd)
          .then((result: PatchPreview | undefined) => {
            if (component.previewArgsKey !== requestKey) return; // a newer call superseded us
            component.preview = result ? { diff: result.diff } : { error: "(no preview: edits did not match)" };
            component.previewPending = false;
            context.invalidate();
          })
          .catch(() => {
            if (component.previewArgsKey !== requestKey) return;
            component.preview = { error: "(preview unavailable)" };
            component.previewPending = false;
            context.invalidate();
          });
      }

      return buildPatchCallComponent(component, args, theme);
    },

    renderResult(result, options, theme, context) {
      const isError = context?.isError ?? false;
      if (isError) {
        const errorText = result.content
          .filter((c) => c.type === "text")
          .map((c) => (c.type === "text" ? c.text : ""))
          .join("\n");
        return new Text(theme.fg("error", errorText), 0, 0);
      }

      const details = result.details as { dryRun?: boolean; fileCount?: number; diff?: string } | undefined;
      const expanded = (options as { expanded?: boolean } | undefined)?.expanded ?? false;
      const summary = theme.fg(
        "muted",
        `${details?.fileCount ?? 1} file(s) changed${details?.dryRun ? " (dry run)" : ""}`,
      );

      if (!expanded) {
        return new Text(summary, 0, 0);
      }

      // Suppress the diff block when the live preview already showed the SAME
      // diff (same args → same edits → same output). Without this, the diff
      // appears twice: once in the renderCall preview, once here. The preview
      // is keyed by args; if the result's args still match the preview's args
      // and the diff string is identical, the preview block already has it.
      const callComponent = (context.state as { callComponent?: PatchCallComponent }).callComponent;
      const preview = callComponent?.preview;
      const previewMatches = preview && !("error" in preview) && preview.diff === details?.diff;
      if (previewMatches) {
        return new Text(summary, 0, 0);
      }

      if (!details?.diff) {
        return new Text(summary, 0, 0);
      }

      return new Text(`${summary}\n${renderDiff(details.diff)}`, 0, 0);
    },
  });
}

/** Write results to their resolved absolute paths. */
async function writeResults(
  groups: Map<string, { displayPath: string; edits: Edit[] }>,
  results: FileResult[],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const [absPath, group] of groups) {
    if (signal?.aborted) throw new Error("Operation aborted");
    const result = results.find((r) => r.displayPath === group.displayPath);
    if (!result) continue;
    await writeFile(absPath, result.newContent, "utf-8");
  }
}
