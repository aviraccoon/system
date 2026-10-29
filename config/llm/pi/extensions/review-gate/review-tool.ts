/**
 * The `review` tool: dispatch the reviewer for a change and record what a
 * staged round covered.
 *
 * The reviewer is the subagent defined in `~/.pi/agent/agents/reviewer.md`; this
 * tool adds the two things a commit gate needs that a free-text dispatch cannot
 * provide: the proposed message as a structured argument (so the message can be
 * compared with the commit) and the tree the round covered (so a later edit
 * invalidates it). The report itself never authorizes anything by its wording:
 * the gate classifies it, and a null verdict records nothing. A paths round
 * records nothing at all, so its report is a pre-review and not a gate input.
 */

import { resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewLedgerEntry } from "../shared/review-ledger";
import { formatGateNote, type GateOutcome } from "./gate";
import { headTree, hooksInactiveReason, normalizeMessage, repoToplevel, worktreeDirty, writeTree } from "./git";

export const ReviewParams = Type.Object({
  task: Type.String({
    description:
      "The review target and the state behind it: the change, what was already run and its result, prior-round findings with their resolutions and checked list, and what the change can break. Never paste the diff; the reviewer fetches it.",
  }),
  scope: Type.Optional(
    Type.Union([Type.Literal("staged"), Type.Literal("paths")], {
      description:
        'What the round covers. "staged" (default) records the commit-gate verdict for the index tree and needs proposedMessage. "paths" reviews a working-tree change and records nothing, so it takes no proposedMessage.',
    }),
  ),
  proposedMessage: Type.Optional(
    Type.String({
      description:
        "The commit message exactly as it will be committed. Required for a staged round; the reviewer judges it against the diff and the gate records it for the commit check. A paths round records nothing, so it rejects one.",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Repository directory to review (defaults to the session cwd)." })),
  journal: Type.Optional(
    Type.String({
      description:
        'Journal to hand the reviewer: a journal dir or entry path under the notes tree, or "none" for a blind round.',
    }),
  ),
  maxTurns: Type.Optional(
    Type.Integer({ minimum: 1, description: "Maximum turns before aborting. Default: the subagent's." }),
  ),
});

export type ReviewScope = "staged" | "paths";

export type ReviewInput = {
  task: string;
  scope?: ReviewScope;
  proposedMessage?: string;
  cwd?: string;
  journal?: string;
  maxTurns?: number;
};

export interface DispatchResult {
  content: AgentToolResult<unknown>["content"];
  isError: boolean;
  details?: unknown;
}

export interface ReviewDeps {
  /** Runs the reviewer through the subagent tool. */
  dispatch: (
    args: { agent: "reviewer"; task: string; cwd?: string; journal?: string; maxTurns?: number },
    options: { signal?: AbortSignal | undefined; onUpdate?: AgentToolUpdateCallback<unknown> | undefined },
  ) => Promise<DispatchResult>;
  /** Answers all four questions; null when one did not answer. */
  classify: (input: { report: string; proposedMessage: string }) => Promise<GateOutcome | null>;
  record: (entry: ReviewLedgerEntry) => void;
  now: () => Date;
  sessionId: string;
}

/**
 * Why a round must not start, or null when the index holds a change.
 *
 * An index identical to HEAD's tree means the round would be recorded against
 * the last commit while the child reads the working tree, and the commit would
 * then be refused with the whole change as an unreviewed delta. A clean working
 * tree at HEAD is a message-only amend and still reviews.
 */
export function nothingStagedRefusal(tree: string, head: string | null, dirty: boolean): string | null {
  // An unborn HEAD is null, which no tree can equal.
  if (head !== tree || !dirty) return null;
  return `review: nothing is staged. The index tree is HEAD's (${tree.slice(0, 8)}), so this round would be recorded against the last commit, and the change you are preparing would show as an unreviewed delta. Stage it, then call the \`review\` tool again. For a working-tree round that records no verdict, pass scope "paths" instead.`;
}

/**
 * The note under a paths round's report: the findings are real, the round is
 * not a gate input, so the commit still needs a staged round of its own.
 */
export const PATHS_ROUND_NOTE = `gate: nothing recorded; a paths round reviews a working-tree change and records no verdict for a commit. Stage that change and call \`review\` with scope "staged" before it is committed.`;

/**
 * A message the reviewer can quote, injected where the task ends.
 *
 * The requirement is stated here, not only in the classifier's question, and it
 * overrides whatever the task says about the message: a delta-scoped round that
 * lists it as settled still judges it, or the commit is refused.
 */
export function taskWithMessage(task: string, message: string): string {
  return `${task}\n\nProposed commit message (verbatim, as it will be committed):\n\n${message}\n\nJudge the message against the diff in this round's report, whatever the task above says about it: a round that does not address it blocks the commit. If the task says an earlier round judged this message and it is unchanged, saying that the message judgment holds against this diff is enough; otherwise judge it here.`;
}

/**
 * A paths round's shape, injected where the task ends.
 *
 * The reviewer prompt's pre-commit rules would otherwise fire on a round that
 * has nothing staged and no message: an empty `git diff --staged` and a missing
 * message are this round's normal state, and the message is judged later, when
 * the change is staged.
 */
export function taskWithPathsScope(task: string): string {
  return `${task}\n\nThis is a path-scoped round: review the paths the task names against the working tree (tracked changes with \`git diff HEAD -- <paths>\`, new files with \`git status --short --untracked-files=all -- <paths>\`), and this round records no verdict, so the index is not its target. An empty \`git diff --staged\` and the absence of a proposed commit message are expected here, not findings; the message is judged in the staged round that follows.`;
}

function textResult(text: string, details?: unknown, isError = false): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/** Report and note as separate blocks, so the renderer can color the note alone. */
function noteResult(report: string, note: string, details?: unknown, isError = false): AgentToolResult<unknown> {
  const content: Array<{ type: "text"; text: string }> = report
    ? [
        { type: "text", text: report },
        { type: "text", text: note },
      ]
    : [{ type: "text", text: note }];
  return { content, details, ...(isError ? { isError: true } : {}) };
}

function reportText(result: DispatchResult): string {
  return result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

/**
 * The subagent tool reports its own refusals — disabled tool, wrong mode,
 * untrusted repo agents, a canceled confirmation — as ordinary content with no
 * results. Only a completed single run of the reviewer is a review round; any
 * other result must record nothing, or a refusal string can be classified clean.
 */
function completedReview(details: unknown): boolean {
  const d = details as { mode?: unknown; results?: unknown } | null;
  if (d?.mode !== "single" || !Array.isArray(d.results) || d.results.length !== 1) return false;
  const result = d.results[0] as { agent?: unknown; exitCode?: unknown; stopReason?: unknown };
  if (result.agent !== "reviewer" || result.exitCode !== 0) return false;
  return result.stopReason !== "aborted" && result.stopReason !== "max_turns_exceeded";
}

export async function runReview(
  params: ReviewInput,
  ctx: ExtensionToolContext,
  deps: ReviewDeps,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<AgentToolResult<unknown>> {
  const cwd = params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd;
  const scope = params.scope ?? "staged";

  // A paths round records nothing, so the message is neither required nor a gate
  // input; accepting one would imply it was judged for a commit.
  if (scope === "paths" && params.proposedMessage !== undefined) {
    return textResult(
      'review: a paths round records nothing, so it takes no proposedMessage. Drop it, or use scope "staged" for a pre-commit round.',
      undefined,
      true,
    );
  }

  // Empty for a paths round, which records no message and reaches neither the
  // classifier nor the ledger.
  let message = "";
  if (params.proposedMessage !== undefined) {
    try {
      message = normalizeMessage(params.proposedMessage, cwd);
    } catch (err) {
      return textResult(`review: could not normalize the proposed message (${String(err)}).`, undefined, true);
    }
    if (!message) {
      return textResult(
        "review: proposedMessage is empty after cleanup; pass the message as it will be committed.",
        undefined,
        true,
      );
    }
  }
  if (scope === "staged" && !message) {
    return textResult(
      "review: proposedMessage is required for a staged round; pass the message as it will be committed.",
      undefined,
      true,
    );
  }

  // Outside a repository there is no ref to gate, but the review is still
  // useful; run it and record nothing. A paths round records nothing either way,
  // so it does not read the tree at all.
  const repo = scope === "staged" ? repoToplevel(cwd) : null;
  let tree: string | null = null;
  let head: string | null = null;
  let dirty = false;
  if (repo) {
    try {
      tree = writeTree(cwd);
      head = headTree(cwd);
      // Only the nothing-staged guard reads the status, so a normal round does
      // not pay for it.
      if (head === tree) dirty = worktreeDirty(cwd);
    } catch (err) {
      return textResult(
        `review: cannot read the index tree or HEAD's tree (${String(err)}). Resolve the repository state first.`,
        undefined,
        true,
      );
    }
  }
  const refusal = tree ? nothingStagedRefusal(tree, head, dirty) : null;
  if (refusal) return textResult(refusal, undefined, true);

  // The child's partials stream through unchanged: the tool's renderResult
  // delegates to the subagent renderer, so the live feed (tool calls, thinking,
  // text) is what a steer decision reads.
  const dispatched = await deps.dispatch(
    {
      agent: "reviewer",
      task: scope === "staged" ? taskWithMessage(params.task, message) : taskWithPathsScope(params.task),
      ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
      ...(params.journal === undefined ? {} : { journal: params.journal }),
      ...(params.maxTurns === undefined ? {} : { maxTurns: params.maxTurns }),
    },
    { signal, onUpdate },
  );

  const report = reportText(dispatched);
  if (dispatched.isError || !completedReview(dispatched.details)) {
    return noteResult(
      report,
      "gate: the reviewer did not complete a review run; nothing recorded. Call the `review` tool again.",
      undefined,
      true,
    );
  }
  if (!report) {
    return textResult(
      "gate: the review returned no report; nothing recorded. Call the `review` tool again.",
      undefined,
      true,
    );
  }
  if (scope === "paths") return noteResult(report, PATHS_ROUND_NOTE, dispatched.details);
  if (!repo || !tree) {
    return noteResult(
      report,
      "gate: not a git repository — no commit gate applies; nothing recorded.",
      dispatched.details,
    );
  }

  let after: string;
  try {
    after = writeTree(cwd);
  } catch (err) {
    return noteResult(
      report,
      `gate: cannot re-read the staged tree (${String(err)}); nothing recorded.`,
      undefined,
      true,
    );
  }
  if (after !== tree) {
    return noteResult(
      report,
      `gate: the staged tree changed during the review (${tree.slice(0, 8)} → ${after.slice(0, 8)}); nothing recorded. Re-stage and call the \`review\` tool again.`,
      undefined,
      true,
    );
  }

  let outcome: GateOutcome | null;
  try {
    outcome = await deps.classify({ report, proposedMessage: message });
  } catch (err) {
    return noteResult(
      report,
      `gate: blocked — the classifier failed (${String(err)}); fail-closed, nothing recorded. Call the \`review\` tool again.`,
      undefined,
      true,
    );
  }
  if (!outcome) {
    return noteResult(report, formatGateNote(null, tree), undefined, true);
  }

  deps.record({
    repo: repo,
    tree,
    message,
    reviewedAt: deps.now().toISOString(),
    sessionId: deps.sessionId,
    verdict: {
      blocking: outcome.blocking,
      reasons: outcome.reasons,
      probabilities: outcome.probabilities,
    },
  });

  // The report and the note travel as separate blocks: the renderer draws the
  // child's turn view from `details` and appends the note from the last block.
  return noteResult(report, cleanNote(outcome, tree, cwd), dispatched.details);
}

/** A clean verdict where the hooks will not run is an honest warning, not a pass. */
function cleanNote(outcome: GateOutcome, tree: string, cwd: string): string {
  const note = formatGateNote(outcome, tree);
  if (outcome.blocking) return note;
  const inactive = hooksInactiveReason(cwd);
  if (!inactive) return note;
  const base = note.endsWith(".") ? note.slice(0, -1) : note;
  return `${base}; the gate's hooks are not active for this repo (${inactive}).`;
}
