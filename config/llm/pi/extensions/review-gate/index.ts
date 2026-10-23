/**
 * Review gate: dispatch the reviewer through one gate-owned tool, record what
 * the round covered, and expose the user-only controls.
 *
 * The verdict is never read from the report's wording by the agent. A decision
 * model answers four typed questions over `{proposedMessage, report}`; a null
 * answer records nothing, which blocks the commit. The ledger is keyed by the
 * staged tree and the normalized message, so an edit after the round, or a
 * message changed before committing, invalidates it.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import { DEFAULT_DECISIONS_MODEL, decisionsComplete } from "../shared/decisions";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import { resolveProviderAuth } from "../shared/model-roles";
import { loadLedger, type ReviewLedgerEntry, recordReview } from "../shared/review-ledger";
import { isShellTool } from "../shared/shell-tools";
import { GATE_QUESTIONS, type GateOutcome, gateFromAnswers } from "./gate";
import { GATE_HOOKS_PATH, hooksInactiveReason, hooksPath, repoToplevel, writeTree } from "./git";
import { renderReviewResult } from "./render";
import { ReviewParams, runReview } from "./review-tool";

const STATE_DIR = join(homedir(), ".pi", "agent", "state");
const LEDGER_PATH = join(STATE_DIR, "review-ledger.json");
const OFF_PATH = join(STATE_DIR, "review-gate-off");

const CLASSIFIER_PROVIDER = process.env.PI_REVIEW_PROVIDER ?? "openrouter";
const CLASSIFIER_MODEL = process.env.PI_REVIEW_CLASSIFIER ?? DEFAULT_DECISIONS_MODEL;

function gateDisabled(offPath: string = OFF_PATH): boolean {
  return existsSync(offPath);
}

function setGateDisabled(disabled: boolean): void {
  if (!disabled) {
    rmSync(OFF_PATH, { force: true });
    return;
  }
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(OFF_PATH, `${JSON.stringify({ at: new Date().toISOString() }, null, 2)}\n`, "utf-8");
}

async function classify(
  ctx: ExtensionContext,
  input: { report: string; proposedMessage: string },
): Promise<GateOutcome | null> {
  const auth = await resolveProviderAuth(CLASSIFIER_PROVIDER, ctx.modelRegistry);
  if (!auth?.apiKey) {
    throw new Error(
      `no credential for "${CLASSIFIER_PROVIDER}"; a role in roles.json must name a model of that provider`,
    );
  }
  const result = await decisionsComplete(
    {
      model: CLASSIFIER_MODEL,
      state: { reviewTarget: "the staged change", proposedMessage: input.proposedMessage, report: input.report },
      questions: GATE_QUESTIONS,
    },
    { apiKey: auth.apiKey, headers: auth.headers, timeoutMs: 30_000, signal: ctx.signal },
  );
  return gateFromAnswers(result.answers);
}

// ── Status ──

function hooksState(cwd: string): { label: string; detail: string } {
  const inactive = hooksInactiveReason(cwd);
  if (!inactive) return { label: "installed", detail: GATE_HOOKS_PATH };
  return { label: hooksPath(cwd) ? "inactive" : "not installed", detail: inactive };
}

/** The picker draws its own title, so the status block's heading is dropped. */
export function dropStatusHeading(text: string): string {
  const [first, ...rest] = text.split("\n");
  return first === "review gate" ? rest.join("\n") : text;
}

export interface StatusPaths {
  ledgerPath: string;
  offPath: string;
}

const DEFAULT_STATUS_PATHS: StatusPaths = { ledgerPath: LEDGER_PATH, offPath: OFF_PATH };

export function statusText(ctx: ExtensionContext, paths: StatusPaths = DEFAULT_STATUS_PATHS): string {
  const repo = repoToplevel(ctx.cwd);
  const hooks = hooksState(ctx.cwd);
  const lines = [
    "review gate",
    `  hooks: ${hooks.label} (${hooks.detail})`,
    `  controls: ${gateDisabled(paths.offPath) ? "disabled" : "enabled"}`,
  ];
  const allEntries = Object.values(loadLedger(paths.ledgerPath).entries);
  const repos = new Set(allEntries.map((entry) => entry.repo)).size;
  const bytes = existsSync(paths.ledgerPath) ? statSync(paths.ledgerPath).size : 0;
  const entryWord = allEntries.length === 1 ? "entry" : "entries";
  const repoWord = repos === 1 ? "repo" : "repos";
  lines.push(
    `  ledger: ${allEntries.length} ${entryWord} across ${repos} ${repoWord} (${(bytes / 1024).toFixed(1)} KB)`,
  );
  if (!repo) {
    lines.push("  repo: not a git repository — no commit gate applies");
    return lines.join("\n");
  }
  let staged = "";
  try {
    staged = writeTree(ctx.cwd);
  } catch (err) {
    staged = `unreadable (${String(err)})`;
  }
  const entries = allEntries.filter((entry) => entry.repo === repo);
  const latest = entries.sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))[0];
  lines.push(`  repo: ${repo}`);
  lines.push(`  staged tree: ${staged ? staged.slice(0, 8) : "unreadable"}`);
  if (latest) {
    const state = latest.verdict.blocking ? "blocked" : "clean";
    lines.push(`  latest review: ${latest.tree.slice(0, 8)} ${state}, ${latest.reviewedAt}`);
    lines.push(`  message: ${(latest.message ?? "").split("\n")[0] || "(none)"}`);
    if (latest.verdict.blocking) lines.push(`  reasons: ${latest.verdict.reasons.join("; ")}`);
  } else {
    lines.push("  latest review: none");
  }
  return lines.join("\n");
}

function showStatus(ctx: ExtensionContext): void {
  const text = statusText(ctx);
  if (ctx.hasUI) void ctx.ui.select(text, ["Done"]);
  else process.stderr.write(`${text}\n`);
}

// ── Command ──

interface GateAction {
  value: string;
  label: string;
  detail: string;
}

function actions(): GateAction[] {
  return [
    { value: "status", label: "Status", detail: "hooks, the staged tree, and the last recorded review" },
    { value: "off", label: "Disable the gate", detail: "writes the user-only off switch the hooks read" },
    { value: "on", label: "Enable the gate", detail: "removes the off switch" },
  ];
}

async function pickAction(ctx: ExtensionContext): Promise<string | undefined> {
  const items = actions();
  const status = statusText(ctx);
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder());
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("accent", theme.bold("Review gate")), 1, 0));
    container.addChild(new Spacer(1));
    // The state is the reason to open this command; show it without a second step.
    // The call site is live-verified only: no test in this tree reaches
    // pickAction's factory.
    container.addChild(new Text(theme.fg("muted", dropStatusHeading(status)), 1, 0));
    container.addChild(new Spacer(1));
    const list = new SelectList(
      items.map((item) => ({ value: item.value, label: item.label, description: item.detail })),
      Math.min(items.length, 12),
      {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      },
    );
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);
    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "↑↓ wrap  enter select  esc cancel"), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder());
    // Input reaches only what the factory returns: a bare Container renders but
    // swallows every key. `handleMouse` is not forwarded because the list sits
    // under a border and spacers, so raw coordinates would click the wrong row.
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function runAction(value: string, ctx: ExtensionContext, ui: ExtensionUIContext): Promise<void> {
  if (value === "status") {
    showStatus(ctx);
    return;
  }
  if (value === "off") {
    setGateDisabled(true);
    ui.notify("review gate disabled; the hooks allow commits until /review-gate on", "warning");
    return;
  }
  if (value === "on") {
    setGateDisabled(false);
    ui.notify("review gate enabled");
    return;
  }
  ui.notify(`review-gate: unknown action "${value}" (status, off, on)`, "warning");
}

// ── Dispatch note for reviewer runs outside the gate ──

function reviewerNames(input: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (typeof input.agent === "string") names.push(input.agent);
  for (const key of ["tasks", "chain"] as const) {
    const list = input[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const agent = (item as { agent?: unknown } | null)?.agent;
      if (typeof agent === "string") names.push(agent);
    }
  }
  return names;
}

const OUTSIDE_GATE_NOTE =
  "review-gate: no commit coverage was recorded for this dispatch. If this was a pre-commit review, re-dispatch with the `review` tool.";

function gateStatePath(path: string): boolean {
  return path.startsWith(`${STATE_DIR}${sep}`) && path.slice(STATE_DIR.length + 1).startsWith("review-");
}

export default function reviewGateExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "review",
    label: "Review",
    description:
      "Dispatch the code reviewer for the staged change and record the commit-gate verdict. Use it for every pre-commit review and every re-review round. Pass the commit message as proposedMessage; the reviewer judges it against the diff and the gate records it so the commit can be checked against it.",
    parameters: ReviewParams,
    renderResult: renderReviewResult,
    promptGuidelines: [
      "Pass the proposed commit message exactly as it will be committed; a message changed after the round invalidates the recorded review.",
      "Put the change, the verification state, prior-round findings with resolutions, and the journal path in `task`; never paste the diff.",
    ],
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return runReview(
        params,
        ctx,
        {
          dispatch: async (args, options) => {
            const outcome = await ctx.executeTool("subagent", args, {
              signal: options.signal,
              onUpdate: options.onUpdate,
            });
            return {
              content: outcome.result.content,
              isError: outcome.isError,
              details: outcome.result.details,
            };
          },
          classify: (input) => classify(ctx, input),
          record: (entry: ReviewLedgerEntry) => {
            recordReview(LEDGER_PATH, entry);
          },
          now: () => new Date(),
          sessionId: ctx.sessionManager.getSessionId(),
        },
        signal,
        onUpdate,
      );
    },
  });

  pi.on("tool_call", async (event) => {
    // The gate's own state is written by this extension, never by a tool: an
    // agent that can write a verdict file can clear its own block.
    if (EDIT_LIKE_TOOLS.includes(event.toolName)) {
      const paths = collectToolPaths(event.toolName, event.input as Record<string, unknown>);
      for (const raw of paths) {
        const absolute = resolvePath(raw.replace(/^@/, "").replace(/^~(?=$|\/)/, homedir()));
        if (gateStatePath(absolute)) {
          return {
            block: true,
            reason: `review-gate state (${absolute}) is not writable from tool calls; use /review-gate status.`,
          };
        }
      }
    }
    if (isShellTool(event.toolName)) {
      const command = (event.input as { command?: unknown }).command;
      // Best-effort text match, not a boundary: a command that reaches the same
      // file another way is not caught.
      if (typeof command === "string" && (command.includes(STATE_DIR) || command.includes(".pi/agent/state"))) {
        return {
          block: true,
          reason: "review-gate state is written only by the extension; use /review-gate status to read it.",
        };
      }
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent" || event.parentToolCallId) return;
    if (!reviewerNames(event.input as Record<string, unknown>).includes("reviewer")) return;
    return { content: [...event.content, { type: "text" as const, text: OUTSIDE_GATE_NOTE }] };
  });

  pi.registerCommand("review-gate", {
    description: "Review gate: status and controls",
    getArgumentCompletions: (prefix) =>
      ["status", "off", "on"]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: `${name} `, label: name })),
    handler: async (args, ctx) => {
      const value = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (value) {
        await runAction(value, ctx, ctx.ui);
        return;
      }
      if (!ctx.hasUI) {
        showStatus(ctx);
        return;
      }
      const chosen = await pickAction(ctx);
      if (chosen === undefined) return;
      await runAction(chosen, ctx, ctx.ui);
    },
  });
}
