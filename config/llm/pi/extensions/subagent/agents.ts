/**
 * Agent discovery — parse .md agent definitions from the user, repo, and notes roots.
 *
 * Pure fs/path logic, no pi imports. Testable with temp directories.
 *
 * Roots, lowest to highest precedence:
 *   ~/.pi/agent/agents                    user (always available)
 *   <repo>/.agents/agents                 repo, neutral shared
 *   <repo>/.pi/agents                     repo, pi-specific
 *   <notes>/<project>/.agents/agents      private, neutral shared
 *   <notes>/<project>/.pi/agents          private, pi-specific
 *
 * Repo roots need an explicit agentScope ("project" or "both"); the private
 * notes roots are user-owned and load in every scope. A later root overrides
 * an earlier one on a name collision, so a private agent can shadow a repo one.
 *
 * Agent .md files use YAML frontmatter:
 *   ---
 *   name: researcher
 *   description: Investigate codebases
 *   tools: read,grep,find,ls,web_search,web_fetch
 *   role: explain
 *   model: openrouter/deepseek/deepseek-v4.1-flash
 *   thinking: high
 *   extensions: web-search
 *   ---
 *   System prompt body...
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { journalDirFor } from "../shared/journal-context";
import { DEFAULT_WORKER_SHELL, isWorkerShell } from "../shared/worker-spec";

export type AgentSource = "user" | "project" | "notes" | "ad-hoc";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  role?: string; // resolves to model from roles.json at runtime
  /** Pinned `provider/model-id` ref. Wins over `role`, and needs no roles.json —
   * the only way a project agent can carry its own model. */
  model?: string;
  /** Thinking level override. Wins over the resolved chain entry's level; with a
   * pinned `model` and no level, the child runs pi's own default. An unknown level
   * is reported as an error rather than passed to the child. */
  thinking?: string;
  extensions?: string[];
  systemPrompt: string;
  source: AgentSource;
  /** Absent for an ad-hoc worker: its definition came from the dispatch, not a file. */
  filePath?: string;
}

/** One root's pair of agent dirs: neutral shared (`.agents/agents`) and
 * pi-specific (`.pi/agents`). Null when the dir does not exist. */
export interface AgentDirs {
  neutral: string | null;
  pi: string | null;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  /** Repo-local dirs, from the nearest ancestor that has either kind. */
  projectDirs: AgentDirs;
  /** Private notes dirs for this project; both null when no notes root was supplied. */
  notesDirs: AgentDirs;
}

const NO_DIRS: AgentDirs = { neutral: null, pi: null };

function parseFrontmatter<T extends Record<string, string>>(
  content: string,
): {
  frontmatter: T;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {} as T, body: content };

  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const eqIndex = line.indexOf(":");
    if (eqIndex > 0) {
      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();
      fm[key] = value;
    }
  }

  return { frontmatter: fm as T, body: match[2] };
}

const INCLUDE_RE = /^@(rules\/[A-Za-z0-9._-]+\.md)$/;

function fragmentPaths(baseDir: string, target: string): string[] {
  const paths: string[] = [];
  let dir = baseDir;
  for (;;) {
    paths.push(path.join(dir, target));
    const parent = path.dirname(dir);
    if (parent === dir) return paths;
    dir = parent;
  }
}

/** Splices `@rules/<name>.md` lines, resolving from `baseDir` then each ancestor; one level, and a
 * missing fragment throws. Only ``` fences are skipped; `~~~` and indented blocks are not. */
export function expandIncludes(body: string, baseDir: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    const match = fenced ? null : line.trim().match(INCLUDE_RE);
    if (!match) {
      out.push(line);
      continue;
    }
    const candidates = fragmentPaths(baseDir, match[1]);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) throw new Error(`include not found: ${match[0]} (tried ${candidates.join(", ")})`);
    const text = fs.readFileSync(found, "utf-8");
    let inFence = false;
    const nested = text.split("\n").find((l) => {
      if (l.trimStart().startsWith("```")) inFence = !inFence;
      return !inFence && INCLUDE_RE.test(l.trim());
    });
    if (nested) throw new Error(`${match[0]} includes another fragment (${nested.trim()}); includes do not nest`);
    out.push(`${text.replace(/\n+$/, "")}\n`);
  }
  return out.join("\n");
}

/** Discovery loads a level more than once, so a skip is reported once per file. */
const reportedSkips = new Set<string>();

export function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) return agents;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const role = frontmatter.role;
    const model = frontmatter.model;
    const thinking = frontmatter.thinking;
    const extensions = frontmatter.extensions
      ?.split(",")
      .map((e) => e.trim())
      .filter(Boolean);

    let systemPrompt: string;
    try {
      systemPrompt = expandIncludes(body, realDir(filePath));
    } catch (error) {
      // A throw here would exit pi: a factory error becomes a load diagnostic and pi exits 1, in every
      // mode, and this runs before trust filtering, so a repo definition could not be opted out of.
      if (!reportedSkips.has(filePath)) {
        reportedSkips.add(filePath);
        process.stderr.write(
          `subagent: skipped ${filePath}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      continue;
    }

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      role: role || undefined,
      model: model || undefined,
      thinking: thinking || undefined,
      extensions: extensions && extensions.length > 0 ? extensions : undefined,
      systemPrompt,
      source,
      filePath,
    });
  }

  return agents;
}

function realDir(file: string): string {
  try {
    return path.dirname(fs.realpathSync(file));
  } catch {
    return path.dirname(file);
  }
}

function dirIfExists(candidate: string): string | null {
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

/** True when the dir holds at least one definition the loader would keep (the
 * source label does not affect the count). */
function hasAgents(dir: string | null): boolean {
  return dir !== null && loadAgentsFromDir(dir, "user").length > 0;
}

/** Repo-local agent dirs: the nearest level with agent files in `.agents/agents`
 * or `.pi/agents`, walking up from cwd and stopping at the home directory (or
 * the filesystem root for a cwd outside home). Both kinds at one level form a
 * single level, so a nested repo's dirs win over an outer repo's, and a level
 * whose definitions all fail to load does not shadow an outer one. A throw out of the
 * load path exits pi with a load diagnostic, which is why the loader catches its own per-file errors. */
export function findNearestProjectAgentDirs(cwd: string, home: string = os.homedir()): AgentDirs {
  let currentDir = cwd;
  while (currentDir !== home) {
    const dirs: AgentDirs = {
      neutral: dirIfExists(path.join(currentDir, ".agents", "agents")),
      pi: dirIfExists(path.join(currentDir, ".pi", "agents")),
    };
    if (hasAgents(dirs.neutral) || hasAgents(dirs.pi)) return dirs;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return NO_DIRS;
    currentDir = parentDir;
  }
  return NO_DIRS;
}

/** Private agent dirs for the project owning `cwd`, under the notes root.
 * The project resolves by cwd basename (worktree-aware), the journal gate's
 * rule, so pi should start in the repo root. */
function notesAgentDirs(notesDir: string, cwd: string): AgentDirs {
  const projectDir = journalDirFor(notesDir, cwd);
  return {
    neutral: dirIfExists(path.join(projectDir, ".agents", "agents")),
    pi: dirIfExists(path.join(projectDir, ".pi", "agents")),
  };
}

/** The repo level holding the discovered agent dirs (both kinds sit one level
 * under it). */
export function projectRootOf(dirs: AgentDirs): string | null {
  const dir = dirs.pi ?? dirs.neutral;
  return dir === null ? null : path.dirname(path.dirname(dir));
}

/** Merge agents from dirs in precedence order; a later file wins a name collision. */
function addAgents(target: Map<string, AgentConfig>, dirs: Array<string | null>, source: AgentSource): void {
  for (const dir of dirs) {
    if (dir === null) continue;
    for (const agent of loadAgentsFromDir(dir, source)) target.set(agent.name, agent);
  }
}

/**
 * Root precedence, lowest first: user, repo neutral, repo pi-specific, notes
 * neutral, notes pi-specific. Repo roots need scope "project" or "both"; the
 * private notes roots load in every scope.
 */
export function discoverAgents(
  cwd: string,
  scope: "user" | "project" | "both",
  notesDir?: string | null,
): AgentDiscoveryResult {
  const agentMap = new Map<string, AgentConfig>();

  if (scope !== "project") {
    addAgents(agentMap, [path.join(os.homedir(), ".pi", "agent", "agents")], "user");
  }

  const projectDirs = findNearestProjectAgentDirs(cwd);
  if (scope !== "user") addAgents(agentMap, [projectDirs.neutral, projectDirs.pi], "project");

  const notesDirs = notesDir ? notesAgentDirs(notesDir, cwd) : NO_DIRS;
  addAgents(agentMap, [notesDirs.neutral, notesDirs.pi], "notes");

  return { agents: Array.from(agentMap.values()), projectDirs, notesDirs };
}

/** Repo agents are repo-controlled and load only for a trusted project; user
 * and notes agents are unaffected. */
export function respectProjectTrust(agents: AgentConfig[], trusted: boolean): AgentConfig[] {
  return trusted ? agents : agents.filter((a) => a.source !== "project");
}

const WORKER_KEYS = new Set(["instructions", "bash"]);

/**
 * Build the agent an inline `spec` describes. A worker owns its instructions and
 * how bounded its shell is, and a field outside them is refused by name rather
 * than ignored: a spec may not name a model, a role, a tool allowlist or an extra
 * extension. `bash` is the one capability it chooses, and it can only add the
 * sandbox.
 */
export function workerAgent(spec: unknown): { agent: AgentConfig } | { error: string } {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return { error: "spec must be an object: { instructions, bash? }." };
  }

  const record = spec as Record<string, unknown>;
  const unsupported = Object.keys(record).find((key) => !WORKER_KEYS.has(key));
  if (unsupported) {
    return {
      error: `spec.${unsupported} is not supported. A worker takes instructions and bash only; model, role, tools and extensions come from agent definitions.`,
    };
  }

  if (typeof record.instructions !== "string" || record.instructions.trim() === "") {
    return { error: "spec.instructions must be a non-empty string." };
  }

  const bash = record.bash ?? DEFAULT_WORKER_SHELL;
  if (!isWorkerShell(bash)) {
    return { error: 'spec.bash must be "sandboxed" or "normal".' };
  }

  return {
    agent: {
      name: "worker",
      description: "Ad-hoc worker",
      systemPrompt: record.instructions,
      extensions: bash === "sandboxed" ? ["sandbox-bash"] : undefined,
      source: "ad-hoc",
    },
  };
}

/**
 * For each section, mark the agents that a later section (or a later dir in the
 * same section) overrides on a name collision. Sections are in precedence
 * order, lowest first; each section's agents are in dir order.
 */
export function markShadowed(sections: AgentConfig[][]): boolean[][] {
  const taken = new Set<string>();
  const shadowed = sections.map(() => [] as boolean[]);
  for (let i = sections.length - 1; i >= 0; i--) {
    for (const agent of [...sections[i]].reverse()) {
      shadowed[i].unshift(taken.has(agent.name));
      taken.add(agent.name);
    }
  }
  return shadowed;
}

export function buildToolDescription(agents: AgentConfig[]): string {
  const lines = [
    "Delegate tasks to specialized subagents with isolated context windows.",
    "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
    'Ad-hoc worker: pass spec: { instructions, bash? } with task instead of agent (single mode only, and no agent/tasks/chain). bash is "sandboxed" (default) or "normal".',
    "Background: pass background: true with a single-mode dispatch to get a run id at once; subagent_wait collects it, subagent_close stops it, and the completion also arrives as a message.",
    'Default agent scope is "user": ~/.pi/agent/agents plus this project\'s private notes agents.',
    'Repo agents (.agents/agents, .pi/agents) need agentScope: "both" (or "project"), project trust, and (interactive sessions) a once-per-session confirmation.',
  ];

  if (agents.length > 0) {
    lines.push("");
    lines.push("Available agents:");
    for (const a of agents) {
      const target = a.model ? `model: ${a.model}` : a.role ? `role: ${a.role}` : undefined;
      const meta = [target, a.thinking ? `thinking: ${a.thinking}` : undefined].filter(Boolean);
      const suffix = meta.length > 0 ? `, ${meta.join(", ")}` : "";
      const tools = a.tools ? ` [${a.tools.join(", ")}]` : "";
      lines.push(`- ${a.name}: ${a.description}${tools}${suffix}`);
    }
  } else {
    lines.push("No agents defined. Add .md files to ~/.pi/agent/agents/ or a .agents/agents/ directory.");
  }

  return lines.join("\n");
}
