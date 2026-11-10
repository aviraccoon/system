/**
 * Subagent extension — delegate tasks to specialized agents with isolated context.
 *
 * Spawns a separate `pi` process for each subagent invocation, giving it a
 * fresh context window. Useful for research tasks that would otherwise bloat
 * the main agent's context.
 *
 * Agent definitions live in ~/.pi/agent/agents/*.md (user-level), the repo's
 * .agents/agents/*.md and .pi/agents/*.md (opt-in via agentScope), and the
 * project's journal dir in the notes tree (private, always available).
 *
 * Toggle: /subagent-toggle or Ctrl+Shift+S to enable/disable the tool.
 * Steer: /subagent-steer or Ctrl+Shift+T to send a message to a running subagent.
 * When disabled, the tool is not registered.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { journalNotesDir } from "../shared/journal-context";
import { stringEnum } from "../shared/schema";
import {
  type AgentConfig,
  buildToolDescription,
  discoverAgents,
  loadAgentsFromDir,
  markShadowed,
  respectProjectTrust,
} from "./agents";
import { BackgroundRuns, clampWaitMs, singleRun } from "./background";
import { planDispatch } from "./dispatch";
import { journalPath, taskForChild } from "./journal-task";
import { renderCall as renderCallFn, renderResult as renderResultFn, withSessionPaths } from "./render";
import {
  getAvailableRoles,
  getFinalOutput,
  getRolePrimaryModel,
  resultFailed,
  runSingleAgent,
  type SingleResult,
  type SubagentDetails,
  type SubagentHandle,
  withChainWarnings,
  withStreamWarning,
} from "./rpc";
import { DEFAULT_SUBAGENT_ROLE } from "./target";
import { AcceptedRoots, PROJECT_TRUST_ENTRY } from "./trust";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const DEFAULT_MAX_TURNS = 30;
const SUBAGENT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "subagent-sessions");

// ── Handle registry for steering ──

let nextHandleId = 1;
const activeHandles = new Map<number, { handle: SubagentHandle; agent: string; task: string; registeredAt: number }>();

function registerHandle(handle: SubagentHandle, agent: string, task: string): number {
  const id = nextHandleId++;
  activeHandles.set(id, { handle, agent, task, registeredAt: Date.now() });
  return id;
}

function unregisterHandle(id: number): void {
  activeHandles.delete(id);
}

function getActiveHandleEntries(): Array<{ id: number; agent: string; task: string }> {
  return Array.from(activeHandles.entries()).map(([id, entry]) => ({
    id,
    agent: entry.agent,
    task: entry.task.length > 60 ? `${entry.task.slice(0, 57)}...` : entry.task,
  }));
}

// ── Tool parameters ──

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = stringEnum(["user", "project", "both"] as const, {
  description:
    'Which repo agent dirs to use: "both" includes .agents/agents and .pi/agents. Default: "user" (repo dirs excluded). Private notes agents always load.',
  default: "user",
});

const WorkerSpecSchema = Type.Object(
  {
    instructions: Type.String({
      description: "The worker's system prompt: what it is, what to do, and what to report back.",
    }),
    bash: Type.Optional(
      stringEnum(["sandboxed", "normal"] as const, {
        description:
          'How bounded the worker\'s shell is. "sandboxed" (default) loads the kernel-confined bash: reads almost anywhere (most dot-entries under the home directory and credential paths are denied), writes only to scratch space, no network. "normal" leaves the built-in shell, where the permission gate\'s mode and score decide what runs.',
        default: "sandboxed",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "A one-off worker instead of a named agent: instructions plus how bounded its shell is. Takes no model, role, tools or extensions, which come from agent definitions.",
  },
);

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({ description: "Name of the agent to invoke (for single mode; omit when passing spec)" }),
  ),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode; with spec, the work)" })),
  spec: Type.Optional(WorkerSpecSchema),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "Array of {agent, task}: multiple items run in parallel, one item runs as a single streaming run (a blank agent or task stays parallel)",
    }),
  ),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the agent process (explicit single mode; a one-item tasks batch uses the item's cwd)",
    }),
  ),
  maxTurns: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Maximum turns before aborting. Prevents runaway loops. Default: ${DEFAULT_MAX_TURNS}.`,
      default: DEFAULT_MAX_TURNS,
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Return a run id at once instead of the answer (single mode only). The completion arrives as a message; subagent_wait collects it early, subagent_close stops it.",
    }),
  ),
  journal: Type.Optional(
    Type.String({
      description:
        'Journal to hand the child: a journal dir or a specific entry file under the notes tree (absolute or ~-prefixed), e.g. "~/notes/llm/system" or "~/notes/llm/system/2026-10-05-01-entry.md". Any journal can be named, not just the session\'s. Every task then starts with a read-the-journal instruction, and the named record must have been written since the last user message or completed dispatch. Pass "none" for a deliberately blind dispatch (blind review, throwaway lookup): no journal is injected and no link or freshness check applies. Default: link the journal path in each task yourself.',
    }),
  ),
});

// ── Extension ──

let toolEnabled = true;

export default function subagentExtension(pi: ExtensionAPI) {
  // Repo roots whose confirmation was accepted this session.
  const acceptedRoots = new AcceptedRoots();
  const backgroundRuns = new BackgroundRuns(pi);

  pi.on("session_start", async (_event, ctx) => {
    // A reload or resume re-instantiates the extension with the same session
    // history — a repository accepted there stays accepted.
    acceptedRoots.restoreFromSession(ctx.sessionManager);
  });

  function registerTool() {
    // Discover agents at registration time for the tool description.
    const allAgents = discoverAgents(process.cwd(), "both", journalNotesDir()).agents;

    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: buildToolDescription(allAgents),
      parameters: SubagentParams,
      promptGuidelines: [
        'Give the dispatch a journal: pass journal: "<journal dir or entry path>" and the tool prepends a read instruction to every task — any journal under the notes tree, not just the session\'s — or write the journal path into each task; edit-guard blocks a dispatch with neither. Pass journal: "none" only when the child deliberately runs without journal context (blind review, throwaway lookup).',
      ],

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        if (!toolEnabled) {
          return {
            content: [
              { type: "text", text: "Subagent tool is disabled. Use /subagent-toggle or Ctrl+Shift+S to re-enable." },
            ],
            details: undefined,
          };
        }

        const agentScope: "user" | "project" | "both" = params.agentScope ?? "user";
        const journal = journalPath(params.journal);
        const trusted = ctx.isProjectTrusted();
        const discovery = discoverAgents(ctx.cwd, agentScope, journalNotesDir());
        const agents = respectProjectTrust(discovery.agents, trusted);

        const makeDetails =
          (mode: "single" | "parallel" | "chain") =>
          (results: SingleResult[]): SubagentDetails => ({
            mode,
            agentScope,
            results,
          });

        const plan = planDispatch(params, {
          discovered: discovery.agents,
          agents,
          agentScope,
          trusted,
          hasUI: ctx.hasUI,
          accepted: (root) => acceptedRoots.has(root),
          projectDirs: discovery.projectDirs,
          cwd: ctx.cwd,
        });
        if (plan.kind === "refuse") {
          return {
            content: [{ type: "text", text: plan.text }],
            details: makeDetails(plan.mode ?? "single")([]),
          };
        }

        // Confirm repo agents once per repository per session.
        if (plan.confirm) {
          const dir = plan.confirm.dirs.join(", ") || "(unknown)";
          const ok = await ctx.ui.confirm(
            "Run project-local agents?",
            `Agents: ${plan.confirm.names.join(", ")}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
          );
          if (!ok) {
            return {
              content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
              details: makeDetails(plan.mode)([]),
            };
          }
          if (plan.confirm.root !== null) {
            acceptedRoots.add(plan.confirm.root);
            pi.appendEntry(PROJECT_TRUST_ENTRY, { root: plan.confirm.root });
          }
        }

        // Background: a handle now, one wake later. Single mode only, because a chain or a batch
        // would need a handle per run and a rule for what one wake means.
        if (params.background) {
          const once = singleRun(plan);
          if ("error" in once) {
            return { content: [{ type: "text", text: once.error }], details: makeDetails("single")([]) };
          }
          const started = backgroundRuns.start(ctx, {
            agents: plan.runAgents,
            agent: once.agent,
            task: taskForChild(once.task, journal),
            cwd: plan.singleCwd,
            maxTurns: params.maxTurns ?? DEFAULT_MAX_TURNS,
          });
          if ("error" in started) {
            return { content: [{ type: "text", text: started.error }], details: makeDetails("single")([]) };
          }
          const run = started.run;
          return {
            content: [
              {
                type: "text",
                text: `Background subagent ${run.id} started [${run.agent}]. You will be told when it finishes; do not poll or sleep. /jobs shows it.`,
              },
            ],
            details: makeDetails("single")([]),
          };
        }

        // Chain mode
        if (plan.mode === "chain" && params.chain) {
          const results: SingleResult[] = [];
          let previousOutput = "";

          for (let i = 0; i < params.chain.length; i++) {
            const step = params.chain[i];
            const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
            const childTask = taskForChild(taskWithContext, journal);

            const chainUpdate = onUpdate
              ? (partial: { content: unknown[]; details?: SubagentDetails }) => {
                  const currentResult = partial.details?.results[0];
                  if (currentResult) {
                    const allResults = [...results, currentResult];
                    const rawContent = partial.content as { type: string; text: string }[] | undefined;
                    const firstText = rawContent && rawContent[0]?.type === "text" ? rawContent[0].text : "";
                    onUpdate({
                      content: [{ type: "text", text: firstText }],
                      details: makeDetails("chain")(allResults),
                    });
                  }
                }
              : undefined;

            let handleId = 0;
            const result = await runSingleAgent(
              ctx.cwd,
              plan.runAgents,
              step.agent,
              childTask,
              step.cwd,
              i + 1,
              signal,
              chainUpdate,
              makeDetails("chain"),
              ctx,
              params.maxTurns ?? DEFAULT_MAX_TURNS,
              (h) => {
                if (handleId) unregisterHandle(handleId);
                handleId = registerHandle(h, step.agent, taskWithContext);
                return () => unregisterHandle(handleId);
              },
            );
            unregisterHandle(handleId);
            results.push(result);

            const isError = resultFailed(result);
            if (isError) {
              const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
              const attemptsNote = (result.attempts ?? 1) > 1 ? ` (after ${result.attempts} attempts)` : "";
              return {
                content: [
                  {
                    type: "text",
                    text: withSessionPaths(
                      withChainWarnings(
                        `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${attemptsNote}`,
                        results,
                      ),
                      [{ path: result.sessionFile, pid: result.pid }],
                    ),
                  },
                ],
                details: makeDetails("chain")(results),
                isError: true,
              };
            }
            // The next step's input is this step's output, so a stream that died
            // after the answer travels with the handoff as a warning.
            previousOutput = withStreamWarning(getFinalOutput(result.messages), result);
          }
          const last = results[results.length - 1];
          return {
            content: [
              {
                type: "text",
                text: withSessionPaths(withChainWarnings(getFinalOutput(last.messages) || "(no output)", results), [
                  { path: last.sessionFile, pid: last.pid },
                ]),
              },
            ],
            details: makeDetails("chain")(results),
          };
        }

        // Parallel mode
        if (plan.mode === "parallel" && plan.parallelTasks) {
          const parallelTasks = plan.parallelTasks;
          if (parallelTasks.length > MAX_PARALLEL_TASKS)
            return {
              content: [
                {
                  type: "text",
                  text: `Too many parallel tasks (${parallelTasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
              ],
              details: makeDetails("parallel")([]),
            };

          const allResults: SingleResult[] = new Array(parallelTasks.length);

          for (let i = 0; i < parallelTasks.length; i++) {
            allResults[i] = {
              agent: parallelTasks[i].agent,
              agentSource: "unknown",
              task: taskForChild(parallelTasks[i].task, journal),
              exitCode: -1,
              messages: [],
              stderr: "",
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
            };
          }

          const emitParallelUpdate = () => {
            if (onUpdate) {
              const running = allResults.filter((r) => r.exitCode === -1).length;
              const done = allResults.filter((r) => r.exitCode !== -1).length;
              onUpdate({
                content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
                details: makeDetails("parallel")([...allResults]),
              });
            }
          };

          // Concurrency-limited parallel execution
          const results = await mapWithConcurrencyLimit(
            parallelTasks,
            MAX_CONCURRENCY,
            async (t: { agent: string; task: string; cwd?: string }, index) => {
              let handleId = 0;
              const childTask = taskForChild(t.task, journal);
              const result = await runSingleAgent(
                ctx.cwd,
                plan.runAgents,
                t.agent,
                childTask,
                t.cwd,
                undefined,
                signal,
                (partial) => {
                  if (partial.details?.results[0]) {
                    allResults[index] = partial.details.results[0];
                    emitParallelUpdate();
                  }
                },
                makeDetails("parallel"),
                ctx,
                params.maxTurns ?? DEFAULT_MAX_TURNS,
                (h) => {
                  if (handleId) unregisterHandle(handleId);
                  handleId = registerHandle(h, t.agent, t.task);
                  return () => unregisterHandle(handleId);
                },
              );
              unregisterHandle(handleId);
              allResults[index] = result;
              emitParallelUpdate();
              return result;
            },
          );

          const successCount = results.filter((r) => !resultFailed(r)).length;
          const summaries = results.map((r) => {
            const output = getFinalOutput(r.messages) || r.errorMessage || r.stderr;
            return `[${r.agent}] ${resultFailed(r) ? "failed" : "completed"}:\n${withStreamWarning(output || "(no output)", r)}`;
          });
          return {
            content: [
              {
                type: "text",
                text: withSessionPaths(
                  `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
                  results.map((r) => ({ path: r.sessionFile, pid: r.pid })),
                ),
              },
            ],
            details: makeDetails("parallel")(results),
          };
        }

        // Single mode
        const { singleAgent, singleTask, singleCwd } = plan;
        if (plan.mode === "single" && singleAgent && singleTask) {
          let handleId = 0;
          const childTask = taskForChild(singleTask, journal);
          const result = await runSingleAgent(
            ctx.cwd,
            plan.runAgents,
            singleAgent,
            childTask,
            singleCwd,
            undefined,
            signal,
            onUpdate as ((partial: { content: unknown[]; details?: SubagentDetails }) => void) | undefined,
            makeDetails("single"),
            ctx,
            params.maxTurns ?? DEFAULT_MAX_TURNS,
            (h) => {
              if (handleId) unregisterHandle(handleId);
              handleId = registerHandle(h, singleAgent, singleTask);
              return () => unregisterHandle(handleId);
            },
          );
          unregisterHandle(handleId);
          const isError = resultFailed(result);
          if (isError) {
            const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
            const attemptsNote = (result.attempts ?? 1) > 1 ? ` (after ${result.attempts} attempts)` : "";
            return {
              content: [
                {
                  type: "text",
                  text: withSessionPaths(`Agent ${result.stopReason || "failed"}: ${errorMsg}${attemptsNote}`, [
                    { path: result.sessionFile, pid: result.pid },
                  ]),
                },
              ],
              details: makeDetails("single")([result]),
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text",
                text: withSessionPaths(withStreamWarning(getFinalOutput(result.messages) || "(no output)", result), [
                  { path: result.sessionFile, pid: result.pid },
                ]),
              },
            ],
            details: makeDetails("single")([result]),
          };
        }

        const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
          details: makeDetails("single")([]),
        };
      },

      renderCall(args, theme, _context) {
        return renderCallFn(args, theme, _context);
      },

      renderResult(result, { expanded, isPartial }, theme, _context) {
        return renderResultFn(result, { expanded, isPartial }, theme, _context);
      },
    });

    pi.registerTool({
      name: "subagent_wait",
      label: "Wait for subagent",
      description:
        "Wait for background subagent runs. A timeout returns their current state, never an error; a finished run returns at once.",
      parameters: Type.Object({
        ids: Type.Optional(
          Type.Array(Type.String(), {
            description: "Run ids or unique prefixes. Omit for every run this session started.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({ minimum: 1000, maximum: 600000, description: "How long to wait. Default 30000." }),
        ),
      }),
      async execute(_toolCallId, params) {
        const { text } = await backgroundRuns.wait(params.ids, clampWaitMs(params.timeoutMs));
        return { content: [{ type: "text", text }], details: undefined };
      },
    });

    pi.registerTool({
      name: "subagent_close",
      label: "Close subagent run",
      description: "Stop a background subagent run, or acknowledge one that finished. The run's record stays in /jobs.",
      parameters: Type.Object({ id: Type.String({ description: "Run id or unique prefix." }) }),
      async execute(_toolCallId, params) {
        const { text } = backgroundRuns.close(params.id);
        return { content: [{ type: "text", text }], details: undefined };
      },
    });
  }

  // Clean up old subagent sessions on load (7-day max age)
  try {
    const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const entries = fs.readdirSync(SUBAGENT_SESSION_DIR);
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(path.join(SUBAGENT_SESSION_DIR, entry));
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(path.join(SUBAGENT_SESSION_DIR, entry));
        }
      } catch {
        /* skip unreadable files */
      }
    }
  } catch {
    /* dir doesn't exist yet — fine */
  }

  // Register the tool
  registerTool();

  const toggleHandler = async (ctx: ExtensionContext) => {
    toolEnabled = !toolEnabled;
    if (toolEnabled) {
      registerTool();
      ctx.ui.notify("Subagent tool enabled", "info");
    } else {
      ctx.ui.notify("Subagent tool disabled (use /subagent-toggle or Ctrl+Shift+S to re-enable)", "warning");
    }
  };

  // /subagent-toggle command
  pi.registerCommand("subagent-toggle", {
    description: "Toggle subagent tool on/off",
    handler: async (_args, ctx) => toggleHandler(ctx),
  });

  // Ctrl+Shift+S shortcut
  pi.registerShortcut("ctrl+shift+s", {
    description: "Toggle subagent tool",
    handler: toggleHandler,
  });

  // /subagent-status command
  pi.registerCommand("subagent-status", {
    description: "List available subagent definitions",
    handler: async (_args, ctx) => {
      const discovery = discoverAgents(ctx.cwd, "both", journalNotesDir());
      const sections: Array<{ title: string; dirs: Array<string | null>; source: AgentConfig["source"] }> = [
        { title: "User agents", dirs: [path.join(os.homedir(), ".pi", "agent", "agents")], source: "user" },
        { title: "Project agents", dirs: [discovery.projectDirs.neutral, discovery.projectDirs.pi], source: "project" },
        {
          title: "Notes agents (private)",
          dirs: [discovery.notesDirs.neutral, discovery.notesDirs.pi],
          source: "notes",
        },
      ];
      const loaded = sections.map((section) => ({
        ...section,
        agents: section.dirs
          .filter((d): d is string => d !== null)
          .flatMap((d) => loadAgentsFromDir(d, section.source)),
      }));

      // Every definition file is listed; a file overridden by a later root (or
      // by .pi/agents in the same root) is marked shadowed.
      const shadowed = markShadowed(loaded.map((section) => section.agents));

      let msg = `Status: ${toolEnabled ? "✓ enabled" : "✗ disabled"}\n\nAvailable subagent definitions:\n`;
      msg +=
        '(shadowed) = a later root also defines the name and wins when it is loaded (repo roots: agentScope "both"/"project").\n';
      if (!ctx.isProjectTrusted() && (discovery.projectDirs.neutral !== null || discovery.projectDirs.pi !== null)) {
        msg += "Project trust is not granted; repo agents are disabled (/trust, then restart pi).\n";
      }
      if (loaded.every((section) => section.agents.length === 0)) msg += "No agents defined.\n";
      for (let i = 0; i < loaded.length; i++) {
        if (loaded[i].agents.length === 0) continue;
        const where = loaded[i].dirs.filter((d): d is string => d !== null).join(", ");
        msg += `\n${loaded[i].title}${where ? ` (${where})` : ""}:\n`;
        for (const [j, agent] of loaded[i].agents.entries()) {
          // Effective target: a pinned model, an explicit role, or the default role.
          const target = agent.model
            ? `model: ${agent.model}`
            : `role: ${agent.role ?? DEFAULT_SUBAGENT_ROLE}${agent.role ? "" : " (default)"}`;
          const thinking = agent.thinking ? `, thinking: ${agent.thinking}` : "";
          const tools = agent.tools ? ` [${agent.tools.join(", ")}]` : " [built-in]";
          msg += `  ${agent.name}${shadowed[i][j] ? " (shadowed)" : ""}${tools} → ${target}${thinking}\n`;
        }
      }

      // Show available roles
      const roles = getAvailableRoles();
      if (roles.length > 0) {
        msg += `\nAvailable roles (from roles.json):\n`;
        for (const r of roles) {
          const primary = getRolePrimaryModel(r);
          msg += `  ${r}${primary ? ` → ${primary}` : ""}\n`;
        }
      }

      msg += `\nTools: --tools allowlist (built-in) + --extension (web-search, etc.)`;
      msg += `\nToggle: /subagent-toggle or Ctrl+Shift+S`;

      await ctx.ui.select(msg, ["Done"]);
    },
  });

  // ── Steering ──

  const steerHandler = async (ctx: ExtensionContext) => {
    const entries = getActiveHandleEntries();

    if (entries.length === 0) {
      ctx.ui.notify("No running subagents to steer", "info");
      return;
    }

    let selectedId: number;

    if (entries.length === 1) {
      selectedId = entries[0].id;
    } else {
      const options = entries.map((e) => `[#${e.id}] ${e.agent}: ${e.task}`);
      const choice = await ctx.ui.select("Select subagent to steer:", options);
      if (!choice) return;
      const idx = options.indexOf(choice);
      if (idx === -1) return;
      selectedId = entries[idx].id;
    }

    const entry = activeHandles.get(selectedId);
    if (!entry?.handle.isStreaming()) {
      ctx.ui.notify("Subagent no longer running", "warning");
      return;
    }

    const message = await ctx.ui.input(`Steer ${entry.agent}`, "Message to send...");
    if (!message) return;

    await entry.handle.steer(message);
    ctx.ui.notify(`Steered ${entry.agent}`, "info");
  };

  pi.registerCommand("subagent-steer", {
    description: "Send a steering message to a running subagent",
    handler: async (_args, ctx) => steerHandler(ctx),
  });

  pi.registerShortcut("ctrl+shift+t", {
    description: "Steer running subagent",
    handler: steerHandler,
  });
}

// ── Concurrency helper ──

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}
