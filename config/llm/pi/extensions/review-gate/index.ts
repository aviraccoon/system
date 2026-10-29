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
import { loadLedger, type ReviewLedgerEntry, recordReview, setOverride } from "../shared/review-ledger";
import { isShellTool } from "../shared/shell-tools";
import { shellDenialReason } from "./denials";
import { isExempt, loadExemptions, removeExemption, setExemption } from "./exempt";
import { GATE_QUESTIONS, type GateOutcome, gateFromAnswers } from "./gate";
import { GATE_HOOKS_PATH, hooksInactiveReason, hooksPath, repoHooks, repoToplevel, writeTree } from "./git";
import { isHookTrusted, loadHookTrust, trustHook } from "./hook-trust";
import { renderReviewResult } from "./render";
import { ReviewParams, runReview } from "./review-tool";

const STATE_DIR = join(homedir(), ".pi", "agent", "state");
const LEDGER_PATH = join(STATE_DIR, "review-ledger.json");
const OFF_PATH = join(STATE_DIR, "review-gate-off");
const EXEMPT_PATH = join(STATE_DIR, "review-gate-exempt.json");
const TRUST_PATH = join(STATE_DIR, "review-hooks-trust.json");

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
  exemptPath: string;
}

const DEFAULT_STATUS_PATHS: StatusPaths = { ledgerPath: LEDGER_PATH, offPath: OFF_PATH, exemptPath: EXEMPT_PATH };

export function statusText(ctx: ExtensionContext, paths: StatusPaths = DEFAULT_STATUS_PATHS): string {
  const repo = repoToplevel(ctx.cwd);
  const hooks = hooksState(ctx.cwd);
  const lines = [
    "review gate",
    `  hooks: ${hooks.label} (${hooks.detail})`,
    `  controls: ${gateDisabled(paths.offPath) ? "disabled" : "enabled"} (agent sessions only)`,
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
  lines.push(`  exempt: ${isExempt(loadExemptions(paths.exemptPath), repo) ? "yes" : "no"}`);
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

const ACTIONS: GateAction[] = [
  { value: "status", label: "Status", detail: "hooks, the staged tree, and the last recorded review" },
  { value: "override", label: "Override this tree", detail: "let the staged tree commit despite a blocking review" },
  { value: "exempt", label: "Exempt this repository", detail: "commits here no longer need a recorded review" },
  { value: "unexempt", label: "Remove the exemption", detail: "commits here need a recorded review again" },
  {
    value: "trust-hooks",
    label: "Trust repository hooks",
    detail: "allow this repository's own hooks to run",
  },
  { value: "off", label: "Disable the gate", detail: "writes the user-only off switch the hooks read" },
  { value: "on", label: "Enable the gate", detail: "removes the off switch" },
];

function needsUI(ui: ExtensionUIContext, action: string): void {
  ui.notify(`review-gate: ${action} needs an interactive session`, "warning");
}

interface CommitTarget {
  repo: string;
  tree: string;
}

function commitTarget(ctx: ExtensionContext, ui: ExtensionUIContext): CommitTarget | null {
  const repo = repoToplevel(ctx.cwd);
  if (!repo) {
    ui.notify("review-gate: this directory is not a git repository", "warning");
    return null;
  }
  try {
    return { repo, tree: writeTree(ctx.cwd) };
  } catch (err) {
    ui.notify(`review-gate: cannot read the staged tree (${String(err)})`, "error");
    return null;
  }
}

async function overrideAction(ctx: ExtensionContext, ui: ExtensionUIContext): Promise<void> {
  if (!ctx.hasUI) return needsUI(ui, "override");
  const target = commitTarget(ctx, ui);
  if (!target) return;
  const reason = await ctx.ui.input(
    "Override the review gate",
    "Why this tree may commit without a clean review (recorded in the ledger)",
  );
  if (!reason?.trim()) {
    ui.notify("review-gate: override cancelled; a reason is required", "warning");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    "Override the gate for this tree?",
    `${target.repo}\ntree ${target.tree.slice(0, 8)}\n\n${reason.trim()}`,
  );
  if (!confirmed) return;
  setOverride(LEDGER_PATH, {
    repo: target.repo,
    tree: target.tree,
    reason: reason.trim(),
    sessionId: ctx.sessionManager.getSessionId(),
    now: new Date(),
  });
  ui.notify(`review-gate: override recorded for tree ${target.tree.slice(0, 8)}`);
}

async function exemptionAction(ctx: ExtensionContext, ui: ExtensionUIContext, exempt: boolean): Promise<void> {
  const repo = repoToplevel(ctx.cwd);
  if (!repo) {
    ui.notify("review-gate: this directory is not a git repository", "warning");
    return;
  }
  if (!ctx.hasUI) return needsUI(ui, exempt ? "exempt" : "unexempt");
  const confirmed = await ctx.ui.confirm(
    exempt ? "Exempt this repository from the gate?" : "Remove the repository's exemption?",
    `${repo}\n\n${
      exempt
        ? "Commits in this repository no longer need a recorded review."
        : "Commits in this repository need a recorded review again."
    }`,
  );
  if (!confirmed) return;
  if (exempt) {
    setExemption(EXEMPT_PATH, {
      repo,
      at: new Date().toISOString(),
      sessionId: ctx.sessionManager.getSessionId(),
    });
    ui.notify("review-gate: repository exempted; /review-gate unexempt reverses it");
    return;
  }
  removeExemption(EXEMPT_PATH, repo);
  ui.notify("review-gate: repository exemption removed");
}

async function trustHooksAction(ctx: ExtensionContext, ui: ExtensionUIContext): Promise<void> {
  const repo = repoToplevel(ctx.cwd);
  if (!repo) {
    ui.notify("review-gate: this directory is not a git repository", "warning");
    return;
  }
  const hooks = repoHooks(ctx.cwd);
  if (hooks.length === 0) {
    ui.notify("review-gate: this repository ships no hooks of its own");
    return;
  }
  const trust = loadHookTrust(TRUST_PATH);
  const pending = hooks.filter((hook) => !isHookTrusted(trust, repo, hook.name, hook.sha256));
  if (pending.length === 0) {
    ui.notify("review-gate: every repository hook is trusted at its current content");
    return;
  }
  if (!ctx.hasUI) {
    ui.notify(
      `review-gate: ${pending.length} untrusted hook(s): ${pending.map((hook) => hook.name).join(", ")}; trust-hooks needs an interactive session`,
      "warning",
    );
    return;
  }
  const trustAll = "Trust all";
  const labels = pending.map((hook) => `${hook.name} (${hook.sha256.slice(0, 12)})`);
  const choice = await ctx.ui.select("Trust repository hooks", [...labels, trustAll]);
  if (!choice) return;
  const chosen =
    choice === trustAll ? pending : pending.filter((hook) => choice === `${hook.name} (${hook.sha256.slice(0, 12)})`);
  const at = new Date().toISOString();
  for (const hook of chosen) trustHook(TRUST_PATH, { repo, hook: hook.name, sha256: hook.sha256, at });
  ui.notify(`review-gate: trusted ${chosen.map((hook) => hook.name).join(", ")}`);
}

async function pickAction(ctx: ExtensionContext): Promise<string | undefined> {
  const items = ACTIONS;
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
  if (value === "override") {
    await overrideAction(ctx, ui);
    return;
  }
  if (value === "exempt" || value === "unexempt") {
    await exemptionAction(ctx, ui, value === "exempt");
    return;
  }
  if (value === "trust-hooks") {
    await trustHooksAction(ctx, ui);
    return;
  }
  if (value === "off" || value === "on") {
    const disable = value === "off";
    if (ctx.hasUI) {
      const confirmed = await ctx.ui.confirm(
        disable ? "Disable the review gate?" : "Enable the review gate?",
        disable
          ? "Commits from agent sessions will not need a recorded review until /review-gate on."
          : "Commits from agent sessions need a recorded review again.",
      );
      if (!confirmed) return;
    }
    setGateDisabled(disable);
    ui.notify(
      disable ? "review gate disabled; the hooks allow commits until /review-gate on" : "review gate enabled",
      disable ? "warning" : "info",
    );
    return;
  }
  ui.notify(`review-gate: unknown action "${value}" (${ACTIONS.map((action) => action.value).join(", ")})`, "warning");
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
  'review-gate: no commit coverage was recorded for this dispatch. Use the `review` tool instead: scope "staged" for a pre-commit round, scope "paths" for a working-tree pre-review.';

function gateStatePath(path: string): boolean {
  return path.startsWith(`${STATE_DIR}${sep}`) && path.slice(STATE_DIR.length + 1).startsWith("review-");
}

export default function reviewGateExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "review",
    label: "Review",
    description:
      'Dispatch the code reviewer for a change and record the commit-gate verdict. Use scope "staged" (the default) for every pre-commit review and re-review round: it records the index tree and the proposed message, and the commit is checked against both. Use scope "paths" for a path-scoped pre-review of a working-tree change; it records nothing, so the commit still needs a staged round.',
    parameters: ReviewParams,
    renderResult: renderReviewResult,
    promptGuidelines: [
      "A staged round needs proposedMessage, passed exactly as it will be committed; a message changed after the round invalidates the recorded review. A paths round takes none, so name the paths in `task` instead.",
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
      if (typeof command !== "string") return;
      const denied = shellDenialReason(command, STATE_DIR);
      if (denied) return { block: true, reason: denied };
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "subagent" || event.parentToolCallId) return;
    if (!reviewerNames(event.input as Record<string, unknown>).includes("reviewer")) return;
    return { content: [...event.content, { type: "text" as const, text: OUTSIDE_GATE_NOTE }] };
  });

  pi.registerCommand("review-gate", {
    description: "Review gate: status, override, exempt, trust-hooks, off/on",
    getArgumentCompletions: (prefix) =>
      ACTIONS.map((action) => action.value)
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
