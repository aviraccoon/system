/**
 * Edit-guard: deterministic content-policy checks on edited files.
 *
 * Agents repeatedly violate written file-content rules (prompt steering loses
 * to training gravity). This extension mirrors those rules as line patterns
 * and appends a self-contained violation message to the tool result right
 * after the edit, while the agent still has context. Silent when clean — no
 * "all good" noise.
 *
 * Rules are data: built-in defaults in rules.ts, replaceable by a user
 * config at ~/.config/llm/edit-guard.json (same shape, whole-table replace).
 *
 * Commands: /todo-check — sweep the project journal TODO.md on demand
 * (wrap-up use: finds stale rule violations no live edit would re-trigger).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import { loadJournalConfig } from "../shared/journal-context";
import { isShellTool } from "../shared/shell-tools";
import {
  type CompiledPathRule,
  compileRules,
  DEFAULT_RULE_CONFIG,
  mergeRuleConfigs,
  type RuleConfig,
  type RuntimeRoots,
  validateRuleConfig,
} from "./rules";
import { formatViolations, scanContent } from "./scan";

function configDir(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/** User rule table; present means whole-table replacement of the defaults. */
function ruleConfigPath(): string {
  return join(configDir(), "llm", "edit-guard.json");
}

function loadRuleConfig(): { config: RuleConfig[]; loadErrors: string[] } {
  const path = ruleConfigPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULT_RULE_CONFIG, loadErrors: [] };
    const msg = err instanceof Error ? err.message : String(err);
    return {
      config: DEFAULT_RULE_CONFIG,
      loadErrors: [`edit-guard: cannot read ${path} (${msg}) — using built-in rules`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      config: DEFAULT_RULE_CONFIG,
      loadErrors: [`edit-guard: ${path} is not valid JSON (${msg}) — custom rules ignored, using built-in rules`],
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      config: DEFAULT_RULE_CONFIG,
      loadErrors: [`edit-guard: ${path} top-level value must be an array of rules — custom rules ignored`],
    };
  }
  const loadErrors: string[] = [];
  const valid: RuleConfig[] = [];
  parsed.forEach((entry, i) => {
    const problem = validateRuleConfig(entry, `${basename(path)}[${i}]`);
    if (problem) loadErrors.push(problem);
    else valid.push(entry as RuleConfig);
  });
  return { config: mergeRuleConfigs(DEFAULT_RULE_CONFIG, valid), loadErrors };
}

function journalNotesDir(): string {
  try {
    return loadJournalConfig().notesDir;
  } catch {
    return join(homedir(), "notes", "llm");
  }
}

/** Resolve a tool-input path the way agents write them: @-prefix, ~, relative. */
function resolveInputPath(raw: string, cwd: string): string {
  let p = raw.startsWith("@") ? raw.slice(1) : raw;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export default function editGuardExtension(pi: ExtensionAPI) {
  let compiled: CompiledPathRule[] = [];
  // Paths whose write-to-existing block was already issued once this session;
  // a re-issued write to the same path proceeds (genuine full rewrite).
  const rewriteAllowed = new Set<string>();

  function startSession(ctx: ExtensionContext) {
    const { config, loadErrors } = loadRuleConfig();
    for (const error of loadErrors) ctx.ui.notify(error, "warning");
    const result = compileRules(config);
    for (const error of result.errors) ctx.ui.notify(error, "warning");
    compiled = result.rules;
  }

  // ── Session lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    startSession(ctx);
  });

  // ── Write-guard: write is for new files, not wholesale replacement ──

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const abs = resolveInputPath(input.path, ctx.cwd);
    if (rewriteAllowed.has(abs) || !existsSync(abs)) return;
    if (statSync(abs).size === 0) return;
    const lines = readFileSync(abs, "utf-8").split("\n").length;
    const rel = relative(ctx.cwd, abs);
    rewriteAllowed.add(abs);
    // Stash the blocked content so the agent can copy it instead of retyping.
    let stashNote = "";
    const content = (event.input as { content?: unknown }).content;
    if (typeof content === "string") {
      const stashPath = join(tmpdir(), `edit-guard-write-${rel.replace(/[^a-zA-Z0-9._-]/g, "-")}-${Date.now()}`);
      writeFileSync(stashPath, content);
      stashNote = ` The blocked content is saved at ${stashPath} (NOT applied). Either cp ${stashPath} <target> (preferred — cheaper than re-emitting long content), or simply re-issue the write (any content) — the path is now allowed for the rest of the session.`;
    }
    return {
      block: true,
      reason:
        `edit-guard: ${rel} already exists (${lines} lines). Don't use write to replace existing files — ` +
        "use patch for targeted changes (write is for genuinely new files only). " +
        "If a full rewrite is genuinely intended, re-issue the write (any content) — the path is then allowed for the rest of the session." +
        stashNote,
    };
  });

  // ── Post-edit scan: append violations to the tool result ──

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;

    const roots: RuntimeRoots = {
      cwd: ctx.cwd,
      notesDir: journalNotesDir(),
      sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
    };

    // ── Shell commands: run the bash-kind rules over the command string ──
    // Any shell tool, not just `bash`: these rules read the command text
    // (output filtering, flag misuse), and a confined shell filters output too.
    if (isShellTool(event.toolName)) {
      const input = event.input as { command?: unknown };
      const command = typeof input.command === "string" ? input.command : "";
      if (command.length === 0) return;
      const blocks: string[] = [];
      const labels: string[] = [];
      for (const rule of compiled) {
        if (rule.kind !== "bash" || rule.rules.length === 0) continue;
        const violations = scanContent(command, rule.rules);
        if (violations.length === 0) continue;
        blocks.push(formatViolations(violations, rule, ""));
        labels.push(...violations.flatMap((v) => v.labels));
      }
      if (blocks.length === 0) return;
      ctx.ui.notify(`edit-guard: ${[...new Set(labels)].join(", ")} (shell command)`, "warning");
      const existing = event.content[0]?.type === "text" ? event.content[0].text : "";
      return {
        content: [{ type: "text" as const, text: `${existing}\n\n${blocks.join("\n\n")}` }],
      };
    }

    if (!EDIT_LIKE_TOOLS.includes(event.toolName)) return;
    const paths = collectToolPaths(event.toolName, event.input as Record<string, unknown>);
    if (paths.length === 0) return;

    const blocks: string[] = [];
    const flaggedFiles = new Set<string>();
    const flaggedLabels = new Set<string>();
    for (const raw of paths) {
      const abs = resolveInputPath(raw, ctx.cwd);
      if (!existsSync(abs)) continue;
      let content: string;
      try {
        content = readFileSync(abs, "utf-8");
      } catch {
        continue;
      }
      for (const rule of compiled) {
        if (rule.kind !== "file" || !rule.matches(abs, roots) || rule.rules.length === 0) continue;
        const violations = scanContent(content, rule.rules);
        if (violations.length === 0) continue;
        blocks.push(formatViolations(violations, rule, relative(ctx.cwd, abs)));
        flaggedFiles.add(abs);
        for (const v of violations) {
          for (const label of v.labels) flaggedLabels.add(label);
        }
      }
    }
    if (blocks.length === 0) return;

    ctx.ui.notify(
      `edit-guard: ${[...flaggedLabels].join(", ")} in ${
        flaggedFiles.size === 1 ? relative(ctx.cwd, [...flaggedFiles][0] ?? "") : `${flaggedFiles.size} files`
      }`,
      "warning",
    );

    const existing = event.content[0]?.type === "text" ? event.content[0].text : "";
    return {
      content: [{ type: "text" as const, text: `${existing}\n\n${blocks.join("\n\n")}` }],
    };
  });

  // ── /todo-check: on-demand sweep of the project journal TODO.md ──

  function scanTarget(abs: string, ctx: ExtensionContext, roots: RuntimeRoots): { blocks: string[]; flagged: number } {
    const blocks: string[] = [];
    let flagged = 0;
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch (err) {
      throw new Error(`cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const rule of compiled) {
      if (rule.kind !== "file" || !rule.matches(abs, roots) || rule.rules.length === 0) continue;
      const violations = scanContent(content, rule.rules);
      if (violations.length === 0) continue;
      blocks.push(formatViolations(violations, rule, relative(ctx.cwd, abs)));
      flagged += violations.length;
    }
    return { blocks, flagged };
  }

  function todoTarget(args: string, ctx: ExtensionContext): string {
    const target = args.trim();
    return target ? resolveInputPath(target, ctx.cwd) : join(journalNotesDir(), basename(ctx.cwd), "TODO.md");
  }

  function sweepReport(result: { blocks: string[] }): string {
    return `${result.blocks.join("\n\n")}\n\nRemove flagged lines that are done items entirely (per the rules above); leave genuinely-open lines untouched. Reply with what you removed.`;
  }

  function rootsFor(ctx: ExtensionContext): RuntimeRoots {
    return {
      cwd: ctx.cwd,
      notesDir: journalNotesDir(),
      sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
    };
  }

  pi.registerCommand("todo-check", {
    description: "Scan the project journal TODO.md (or a given path) for rule violations",
    handler: async (args, ctx) => {
      if (compiled.length === 0) startSession(ctx);
      const abs = todoTarget(args, ctx);
      if (!existsSync(abs)) {
        ctx.ui.notify(`edit-guard: not found: ${abs}`, "warning");
        return;
      }
      let result: { blocks: string[]; flagged: number };
      try {
        result = scanTarget(abs, ctx, rootsFor(ctx));
      } catch (err) {
        ctx.ui.notify(`edit-guard: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      if (result.blocks.length === 0) {
        ctx.ui.notify(`edit-guard: clean — ${abs}`, "info");
        return;
      }
      pi.sendUserMessage(`[/todo-check ${abs}]\n\n${sweepReport(result)}`);
      ctx.ui.notify(
        `edit-guard: ${result.flagged} suspect line${result.flagged === 1 ? "" : "s"} — sent to agent`,
        "warning",
      );
    },
  });

  // ── todo_check tool: the agent runs the same sweep (wrap-up) ──

  pi.registerTool({
    name: "todo_check",
    label: "TODO Check",
    description:
      "Scan the project journal TODO.md (or a given path) for content-rule violations: done items, commit-hash narration, self-deleting lines. Run it when maintaining a TODO.md or at wrap-up.",
    promptSnippet:
      "todo_check: Scan the project journal TODO.md (or a given path) for rule violations (done items, done narration). Run when maintaining a TODO.md or at wrap-up; remove flagged lines.",
    promptGuidelines: [
      "After finishing work a TODO.md tracks (or at wrap-up), run todo_check on it; flagged lines are either fully done (delete them) or hold leftover work (strip the done narration, keep the rest).",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "File to scan. Defaults to the current project's journal TODO.md." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (compiled.length === 0) startSession(ctx);
      const abs = todoTarget(typeof params.path === "string" ? params.path : "", ctx);
      if (!existsSync(abs)) {
        return { content: [{ type: "text", text: `edit-guard: not found: ${abs}` }], details: undefined };
      }
      let result: { blocks: string[]; flagged: number };
      try {
        result = scanTarget(abs, ctx, rootsFor(ctx));
      } catch (err) {
        return {
          content: [{ type: "text", text: `edit-guard: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
      if (result.blocks.length === 0) {
        return { content: [{ type: "text", text: `edit-guard: clean — ${abs}` }], details: undefined };
      }
      return { content: [{ type: "text", text: sweepReport(result) }], details: undefined };
    },
  });
}
