/**
 * The `review` tool: dispatch the reviewer for the staged change and record
 * what it covered.
 *
 * The reviewer is the subagent defined in `~/.pi/agent/agents/reviewer.md`; this
 * tool adds the two things a commit gate needs that a free-text dispatch cannot
 * provide: the proposed message as a structured argument (so the message can be
 * compared with the commit) and the tree the round covered (so a later edit
 * invalidates it). The report itself never authorizes anything by its wording:
 * the gate classifies it, and a null verdict records nothing.
 */

import { resolve } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ReviewLedgerEntry } from "../shared/review-ledger";
import { formatGateNote, type GateOutcome } from "./gate";
import { hasCommentLines, hooksInactiveReason, normalizeMessage, repoToplevel, writeTree } from "./git";

export const ReviewParams = Type.Object({
  task: Type.String({
    description:
      "The review target and the state behind it: the change, what was already run and its result, prior-round findings with their resolutions and checked list, and what the change can break. Never paste the diff; the reviewer fetches it.",
  }),
  proposedMessage: Type.String({
    description:
      "The commit message exactly as it will be committed. The reviewer judges it against the diff, and the gate records it for the commit check.",
  }),
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

export type ReviewInput = {
  task: string;
  proposedMessage: string;
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

/** A message the reviewer can quote, injected where the task ends. */
export function taskWithMessage(task: string, message: string): string {
  return `${task}\n\nProposed commit message (verbatim, as it will be committed; judge it against the diff):\n\n${message}`;
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

  let message: string;
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
  if (hasCommentLines(params.proposedMessage, cwd)) {
    return textResult(
      "review: proposedMessage has a comment line (it starts with #); git commit -m keeps it but the gate's normalization drops it, so the reviewer would never see that line. Remove it.",
      undefined,
      true,
    );
  }

  // Outside a repository there is no ref to gate, but the review is still
  // useful; run it and record nothing.
  const repo = repoToplevel(cwd);
  let tree: string | null = null;
  if (repo) {
    try {
      tree = writeTree(cwd);
    } catch (err) {
      return textResult(
        `review: cannot read the staged tree (${String(err)}). Resolve the index first.`,
        undefined,
        true,
      );
    }
  }

  // The child's partials stream through unchanged: the tool's renderResult
  // delegates to the subagent renderer, so the live feed (tool calls, thinking,
  // text) is what a steer decision reads.
  const dispatched = await deps.dispatch(
    {
      agent: "reviewer",
      task: taskWithMessage(params.task, message),
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
      "gate: the reviewer did not complete a review run; nothing recorded. Re-dispatch.",
      undefined,
      true,
    );
  }
  if (!report) {
    return textResult("gate: the review returned no report; nothing recorded. Re-dispatch.", undefined, true);
  }
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
      `gate: the staged tree changed during the review (${tree.slice(0, 8)} → ${after.slice(0, 8)}); nothing recorded. Re-stage and re-dispatch.`,
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
      `gate: blocked — the classifier failed (${String(err)}); fail-closed, nothing recorded. Re-dispatch.`,
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
