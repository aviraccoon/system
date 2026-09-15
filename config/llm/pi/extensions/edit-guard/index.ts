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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectToolPaths, EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import { loadJournalConfig } from "../shared/journal-context";
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

  // ── Post-edit scan: append violations to the tool result ──

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (!EDIT_LIKE_TOOLS.includes(event.toolName)) return;
    const paths = collectToolPaths(event.toolName, event.input as Record<string, unknown>);
    if (paths.length === 0) return;

    const roots: RuntimeRoots = {
      cwd: ctx.cwd,
      notesDir: journalNotesDir(),
      sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
    };

    const blocks: string[] = [];
    const flaggedFiles = new Set<string>();
    let flaggedLines = 0;
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
        if (!rule.matches(abs, roots) || rule.rules.length === 0) continue;
        const violations = scanContent(content, rule.rules);
        if (violations.length === 0) continue;
        blocks.push(formatViolations(violations, rule, relative(ctx.cwd, abs)));
        flaggedFiles.add(abs);
        flaggedLines += violations.length;
      }
    }
    if (blocks.length === 0) return;

    ctx.ui.notify(
      flaggedFiles.size === 1
        ? `edit-guard: ${flaggedLines} suspect line${flaggedLines === 1 ? "" : "s"} in ${relative(ctx.cwd, [...flaggedFiles][0] ?? "")}`
        : `edit-guard: ${flaggedLines} suspect line${flaggedLines === 1 ? "" : "s"} across ${flaggedFiles.size} files`,
      "warning",
    );

    const existing = event.content[0]?.type === "text" ? event.content[0].text : "";
    return {
      content: [{ type: "text" as const, text: `${existing}\n\n${blocks.join("\n\n")}` }],
    };
  });

  // ── /todo-check: on-demand sweep of the project journal TODO.md ──

  pi.registerCommand("todo-check", {
    description: "Scan the project journal TODO.md (or a given path) for rule violations",
    handler: async (args, ctx) => {
      if (compiled.length === 0) startSession(ctx);
      const target = args.trim();
      const abs = target ? resolveInputPath(target, ctx.cwd) : join(journalNotesDir(), basename(ctx.cwd), "TODO.md");
      if (!existsSync(abs)) {
        ctx.ui.notify(`edit-guard: not found: ${abs}`, "warning");
        return;
      }

      const roots: RuntimeRoots = {
        cwd: ctx.cwd,
        notesDir: journalNotesDir(),
        sessionsDir: join(homedir(), ".pi", "agent", "sessions"),
      };
      const blocks: string[] = [];
      let flaggedLines = 0;
      let content = "";
      try {
        content = readFileSync(abs, "utf-8");
      } catch (err) {
        ctx.ui.notify(`edit-guard: cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      for (const rule of compiled) {
        if (!rule.matches(abs, roots) || rule.rules.length === 0) continue;
        const violations = scanContent(content, rule.rules);
        if (violations.length === 0) continue;
        blocks.push(formatViolations(violations, rule, relative(ctx.cwd, abs)));
        flaggedLines += violations.length;
      }

      if (blocks.length === 0) {
        ctx.ui.notify(`edit-guard: clean — ${abs}`, "info");
        return;
      }

      const report = `[/todo-check ${abs}]\n\n${blocks.join("\n\n")}\n\nRemove flagged lines that are done items entirely (per the rules above); leave genuinely-open lines untouched. Reply with what you removed.`;
      pi.sendUserMessage(report);
      ctx.ui.notify(
        `edit-guard: ${flaggedLines} suspect line${flaggedLines === 1 ? "" : "s"} — sent to agent`,
        "warning",
      );
    },
  });
}
