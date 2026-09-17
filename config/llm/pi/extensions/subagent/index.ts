/**
 * Subagent extension — delegate tasks to specialized agents with isolated context.
 *
 * Spawns a separate `pi` process for each subagent invocation, giving it a
 * fresh context window. Useful for research tasks that would otherwise bloat
 * the main agent's context.
 *
 * Agent definitions live in ~/.pi/agent/agents/*.md (user-level) and
 * .pi/agents/*.md (project-level, requires explicit opt-in).
 *
 * Toggle: /subagent-toggle or Ctrl+Shift+S to enable/disable the tool.
 * Steer: /subagent-steer or Ctrl+Shift+T to send a message to a running subagent.
 * When disabled, the tool is not registered.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type AgentConfig,
  buildToolDescription,
  discoverAgents,
  findNearestProjectAgentsDir,
  loadAgentsFromDir,
} from "./agents";
import { renderCall as renderCallFn, renderResult as renderResultFn, withSessionPaths } from "./render";
import {
  getAvailableRoles,
  getFinalOutput,
  getRolePrimaryModel,
  runSingleAgent,
  type SingleResult,
  type SubagentDetails,
  type SubagentHandle,
} from "./rpc";

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

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
  task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
  chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
  agentScope: Type.Optional(AgentScopeSchema),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
  maxTurns: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: `Maximum turns before aborting. Prevents runaway loops. Default: ${DEFAULT_MAX_TURNS}.`,
      default: DEFAULT_MAX_TURNS,
    }),
  ),
});

// ── Extension ──

let toolEnabled = true;

export default function subagentExtension(pi: ExtensionAPI) {
  function registerTool() {
    // Discover agents at registration time for the tool description.
    const userAgents = loadAgentsFromDir(path.join(os.homedir(), ".pi", "agent", "agents"), "user");
    const projectAgentsDir = findNearestProjectAgentsDir(process.cwd());
    const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];
    const allAgents = [...userAgents, ...projectAgents];

    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: buildToolDescription(allAgents),
      parameters: SubagentParams,

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
        const discovery = discoverAgents(ctx.cwd, agentScope);
        const agents = discovery.agents;

        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

        const makeDetails =
          (mode: "single" | "parallel" | "chain") =>
          (results: SingleResult[]): SubagentDetails => ({
            mode,
            agentScope,
            projectAgentsDir: discovery.projectAgentsDir,
            results,
          });

        if (modeCount !== 1) {
          const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
          return {
            content: [
              { type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}` },
            ],
            details: makeDetails("single")([]),
          };
        }

        // Confirm project-local agents
        if ((agentScope === "project" || agentScope === "both") && params.confirmProjectAgents !== false && ctx.hasUI) {
          const requestedAgentNames = new Set<string>();
          if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
          if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
          if (params.agent) requestedAgentNames.add(params.agent);

          const projectAgentsRequested = Array.from(requestedAgentNames)
            .map((name) => agents.find((a) => a.name === name))
            .filter((a): a is AgentConfig => a?.source === "project");

          if (projectAgentsRequested.length > 0) {
            const names = projectAgentsRequested.map((a) => a.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            const ok = await ctx.ui.confirm(
              "Run project-local agents?",
              `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
            );
            if (!ok)
              return {
                content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
                details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
              };
          }
        }

        // Chain mode
        if (params.chain && params.chain.length > 0) {
          const results: SingleResult[] = [];
          let previousOutput = "";

          for (let i = 0; i < params.chain.length; i++) {
            const step = params.chain[i];
            const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

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
              agents,
              step.agent,
              taskWithContext,
              step.cwd,
              i + 1,
              signal,
              chainUpdate,
              makeDetails("chain"),
              ctx,
              params.maxTurns ?? DEFAULT_MAX_TURNS,
              (h) => {
                handleId = registerHandle(h, step.agent, taskWithContext);
              },
            );
            unregisterHandle(handleId);
            results.push(result);

            const isError =
              result.exitCode !== 0 ||
              result.stopReason === "error" ||
              result.stopReason === "aborted" ||
              result.stopReason === "max_turns_exceeded";
            if (isError) {
              const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
              return {
                content: [
                  {
                    type: "text",
                    text: withSessionPaths(`Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}`, [
                      result.sessionFile,
                    ]),
                  },
                ],
                details: makeDetails("chain")(results),
                isError: true,
              };
            }
            previousOutput = getFinalOutput(result.messages);
          }
          return {
            content: [
              {
                type: "text",
                text: withSessionPaths(getFinalOutput(results[results.length - 1].messages) || "(no output)", [
                  results[results.length - 1].sessionFile,
                ]),
              },
            ],
            details: makeDetails("chain")(results),
          };
        }

        // Parallel mode
        if (params.tasks && params.tasks.length > 0) {
          if (params.tasks.length > MAX_PARALLEL_TASKS)
            return {
              content: [
                {
                  type: "text",
                  text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
                },
              ],
              details: makeDetails("parallel")([]),
            };

          const allResults: SingleResult[] = new Array(params.tasks.length);

          for (let i = 0; i < params.tasks.length; i++) {
            allResults[i] = {
              agent: params.tasks[i].agent,
              agentSource: "unknown",
              task: params.tasks[i].task,
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
            params.tasks,
            MAX_CONCURRENCY,
            async (t: { agent: string; task: string; cwd?: string }, index) => {
              let handleId = 0;
              const result = await runSingleAgent(
                ctx.cwd,
                agents,
                t.agent,
                t.task,
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
                  handleId = registerHandle(h, t.agent, t.task);
                },
              );
              unregisterHandle(handleId);
              allResults[index] = result;
              emitParallelUpdate();
              return result;
            },
          );

          const successCount = results.filter((r) => r.exitCode === 0).length;
          const summaries = results.map((r) => {
            const output = getFinalOutput(r.messages);
            return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}:\n${output || "(no output)"}`;
          });
          return {
            content: [
              {
                type: "text",
                text: withSessionPaths(
                  `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
                  results.map((r) => r.sessionFile),
                ),
              },
            ],
            details: makeDetails("parallel")(results),
          };
        }

        // Single mode
        if (params.agent && params.task) {
          const singleAgent = params.agent;
          const singleTask = params.task;
          let handleId = 0;
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            singleAgent,
            singleTask,
            params.cwd,
            undefined,
            signal,
            onUpdate as ((partial: { content: unknown[]; details?: SubagentDetails }) => void) | undefined,
            makeDetails("single"),
            ctx,
            params.maxTurns ?? DEFAULT_MAX_TURNS,
            (h) => {
              handleId = registerHandle(h, singleAgent, singleTask);
            },
          );
          unregisterHandle(handleId);
          const isError =
            result.exitCode !== 0 ||
            result.stopReason === "error" ||
            result.stopReason === "aborted" ||
            result.stopReason === "max_turns_exceeded";
          if (isError) {
            const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
            return {
              content: [
                {
                  type: "text",
                  text: withSessionPaths(`Agent ${result.stopReason || "failed"}: ${errorMsg}`, [result.sessionFile]),
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
                text: withSessionPaths(getFinalOutput(result.messages) || "(no output)", [result.sessionFile]),
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
      const userAgents = loadAgentsFromDir(path.join(os.homedir(), ".pi", "agent", "agents"), "user");
      const projectAgentsDir = findNearestProjectAgentsDir(ctx.cwd);
      const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

      let msg = `Status: ${toolEnabled ? "✓ enabled" : "✗ disabled"}\n\nAvailable subagent definitions:\n`;
      if (userAgents.length > 0) {
        msg += "User agents (~/.pi/agent/agents/):\n";
        for (const a of userAgents) {
          const role = a.role || "(none)";
          const tools = a.tools ? ` [${a.tools.join(", ")}]` : " [built-in]";
          msg += `  ${a.name}${tools} → role: ${role}\n`;
        }
      } else {
        msg += "No user agents defined.\n";
      }

      if (projectAgents.length > 0) {
        msg += `\nProject agents (${projectAgentsDir}):\n`;
        for (const a of projectAgents) {
          const role = a.role || "(none)";
          const tools = a.tools ? ` [${a.tools.join(", ")}]` : " [built-in]";
          msg += `  ${a.name}${tools} → role: ${role}\n`;
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
