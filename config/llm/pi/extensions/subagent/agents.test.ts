import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AgentConfig,
  buildToolDescription,
  discoverAgents,
  expandIncludes,
  findNearestProjectAgentDirs,
  loadAgentsFromDir,
  markShadowed,
  projectRootOf,
  respectProjectTrust,
  workerAgent,
} from "./agents";

const TEST_DIR = join(tmpdir(), `subagent-agents-test-${process.pid}`);

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeDir(...paths: string[]): string {
  const dir = join(TEST_DIR, ...paths);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgent(dir: string, filename: string, frontmatter: Record<string, string>, body = ""): void {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(dir, filename), `---\n${fm}\n---\n${body}`);
}

// ── loadAgentsFromDir ──

describe("loadAgentsFromDir", () => {
  test("returns empty for nonexistent directory", () => {
    expect(loadAgentsFromDir("/nonexistent/path", "user")).toEqual([]);
  });

  test("returns empty for directory with no .md files", () => {
    const dir = makeDir("empty");
    writeFileSync(join(dir, "readme.txt"), "not an agent");
    expect(loadAgentsFromDir(dir, "user")).toEqual([]);
  });

  test("skips .md files without required frontmatter", () => {
    const dir = makeDir("no-fm");
    writeFileSync(join(dir, "notes.md"), "Just some notes");
    writeFileSync(join(dir, "partial.md"), "---\nname: only-name\n---\nbody");
    writeFileSync(join(dir, "partial2.md"), "---\ndescription: only-desc\n---\nbody");
    expect(loadAgentsFromDir(dir, "user")).toEqual([]);
  });

  test("loads agent with name and description", () => {
    const dir = makeDir("basic");
    writeAgent(
      dir,
      "researcher.md",
      { name: "researcher", description: "Investigates codebases" },
      "You are a researcher.",
    );

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe("researcher");
    expect(agents[0].description).toBe("Investigates codebases");
    expect(agents[0].systemPrompt.trim()).toBe("You are a researcher.");
    expect(agents[0].source).toBe("user");
    expect(agents[0].tools).toBeUndefined();
    expect(agents[0].role).toBeUndefined();
    expect(agents[0].model).toBeUndefined();
    expect(agents[0].thinking).toBeUndefined();
    expect(agents[0].extensions).toBeUndefined();
  });

  test("parses a pinned model and thinking level", () => {
    const dir = makeDir("pinned-model");
    writeAgent(
      dir,
      "pinned.md",
      {
        name: "pinned",
        description: "Runs one model",
        model: "openrouter/deepseek/deepseek-v4.1-flash",
        thinking: "high",
      },
      "body",
    );

    const agents = loadAgentsFromDir(dir, "project");
    expect(agents[0].model).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(agents[0].thinking).toBe("high");
    // model and role are independent: a pinned model needs no roles.json entry.
    expect(agents[0].role).toBeUndefined();
  });

  test("parses tools, role, and extensions from frontmatter", () => {
    const dir = makeDir("full-fm");
    writeAgent(
      dir,
      "coder.md",
      {
        name: "coder",
        description: "Writes code",
        tools: "read, write, edit, bash",
        role: "draft",
        extensions: "web-search, lsp",
      },
      "Write code.",
    );

    const agents = loadAgentsFromDir(dir, "project");
    expect(agents).toHaveLength(1);
    expect(agents[0].tools).toEqual(["read", "write", "edit", "bash"]);
    expect(agents[0].role).toBe("draft");
    expect(agents[0].extensions).toEqual(["web-search", "lsp"]);
    expect(agents[0].source).toBe("project");
  });

  test("labels the notes source", () => {
    const dir = makeDir("notes-source");
    writeAgent(dir, "n.md", { name: "note", description: "d" }, "N");
    expect(loadAgentsFromDir(dir, "notes")[0].source).toBe("notes");
  });

  test("trims whitespace in comma-separated fields", () => {
    const dir = makeDir("whitespace");
    writeAgent(dir, "sloppy.md", { name: "sloppy", description: "test", tools: " read , write , edit " }, "body");

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents[0].tools).toEqual(["read", "write", "edit"]);
  });

  test("ignores empty tools/extensions", () => {
    const dir = makeDir("empty-tools");
    writeAgent(dir, "minimal.md", { name: "min", description: "test", tools: ", ," }, "body");

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents[0].tools).toBeUndefined();
  });

  test("loads multiple agents from one directory", () => {
    const dir = makeDir("multi");
    writeAgent(dir, "a.md", { name: "alpha", description: "Agent A" }, "A");
    writeAgent(dir, "b.md", { name: "beta", description: "Agent B" }, "B");
    // Non-.md file should be skipped
    writeFileSync(join(dir, "gamma.txt"), "not an agent");

    const agents = loadAgentsFromDir(dir, "user");
    expect(agents).toHaveLength(2);
    expect(agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  });
});

// ── findNearestProjectAgentDirs ──

describe("findNearestProjectAgentDirs", () => {
  test("returns nulls when neither dir exists", () => {
    const dir = makeDir("no-agents");
    expect(findNearestProjectAgentDirs(dir)).toEqual({ neutral: null, pi: null });
  });

  test("finds .pi/agents with agent files in the current directory", () => {
    const project = makeDir("project");
    const agentsDir = makeDir("project", ".pi", "agents");
    writeAgent(agentsDir, "a.md", { name: "a", description: "A" }, "A");
    expect(findNearestProjectAgentDirs(project)).toEqual({ neutral: null, pi: agentsDir });
  });

  test("a broken directive is skipped, not fatal to discovery", () => {
    const project = makeDir("project-broken");
    const agentsDir = makeDir("project-broken", ".pi", "agents");
    writeAgent(agentsDir, "a.md", { name: "a", description: "A" }, "@rules/missing.md");
    writeAgent(agentsDir, "b.md", { name: "b", description: "B" }, "B");
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(loadAgentsFromDir(agentsDir, "project").map((a) => a.name)).toEqual(["b"]);
      expect(findNearestProjectAgentDirs(project)).toEqual({ neutral: null, pi: agentsDir });
    } finally {
      process.stderr.write = original;
    }
    const report = written.join("");
    expect(report).toContain("missing.md");
    expect(report.match(/skipped/g)).toHaveLength(1);
  });

  test("a level whose only definition is broken does not shadow the outer one", () => {
    makeDir("outer-repo");
    const outerAgents = makeDir("outer-repo", ".pi", "agents");
    writeAgent(outerAgents, "o.md", { name: "o", description: "O" }, "O");
    const inner = makeDir("outer-repo", "nested");
    const innerAgents = makeDir("outer-repo", "nested", ".pi", "agents");
    writeAgent(innerAgents, "b.md", { name: "b", description: "B" }, "@rules/missing.md");
    expect(findNearestProjectAgentDirs(inner)).toEqual({ neutral: null, pi: outerAgents });
  });

  test("finds both kinds at the same level", () => {
    const project = makeDir("project-both");
    const neutral = makeDir("project-both", ".agents", "agents");
    const pi = makeDir("project-both", ".pi", "agents");
    writeAgent(neutral, "n.md", { name: "n", description: "N" }, "N");
    expect(findNearestProjectAgentDirs(project)).toEqual({ neutral, pi });
  });

  test("walks up to parent directories", () => {
    const agentsDir = makeDir("root", ".pi", "agents");
    writeAgent(agentsDir, "a.md", { name: "a", description: "A" }, "A");
    const child = makeDir("root", "src", "lib");
    expect(findNearestProjectAgentDirs(child).pi).toBe(agentsDir);
  });

  test("the nearest level wins even when only the other kind exists there", () => {
    const outer = makeDir("outer", ".pi", "agents");
    writeAgent(outer, "o.md", { name: "o", description: "O" }, "O");
    const neutral = makeDir("outer", "vendor", "pkg", ".agents", "agents");
    writeAgent(neutral, "n.md", { name: "n", description: "N" }, "N");
    expect(findNearestProjectAgentDirs(join(TEST_DIR, "outer", "vendor", "pkg"))).toEqual({ neutral, pi: null });
  });

  test("a nearer level with no agent definitions does not shadow an outer one", () => {
    const outer = makeDir("outer-empty", ".pi", "agents");
    writeAgent(outer, "o.md", { name: "o", description: "O" }, "O");
    const nearer = makeDir("outer-empty", "vendor", "pkg", ".agents", "agents");
    writeFileSync(join(nearer, "README.md"), "not an agent");
    expect(findNearestProjectAgentDirs(join(TEST_DIR, "outer-empty", "vendor", "pkg")).pi).toBe(outer);
  });

  test("does not treat directories at or above home as repo levels", () => {
    const home = makeDir("home");
    const agentsDir = makeDir("home", ".agents", "agents");
    writeAgent(agentsDir, "h.md", { name: "h", description: "H" }, "H");
    expect(findNearestProjectAgentDirs(makeDir("home", "project"), home)).toEqual({ neutral: null, pi: null });
  });

  test("finds a level below home", () => {
    const home = makeDir("home-below");
    const agentsDir = makeDir("home-below", "dev", ".pi", "agents");
    writeAgent(agentsDir, "d.md", { name: "d", description: "D" }, "D");
    expect(findNearestProjectAgentDirs(join(TEST_DIR, "home-below", "dev", "repo"), home).pi).toBe(agentsDir);
  });

  test("stops at filesystem root", () => {
    // A deeply nested path with no agent dirs anywhere above it
    const dir = makeDir("a", "b", "c");
    expect(findNearestProjectAgentDirs(dir)).toEqual({ neutral: null, pi: null });
  });
});

// ── discoverAgents ──

describe("discoverAgents", () => {
  test("scope=user loads only user agents", () => {
    // Create user agents dir
    const userDir = makeDir("user-agents");
    writeAgent(userDir, "r.md", { name: "researcher", description: "Research" }, "R");

    // Create project agents dir
    const projectDir = makeDir("project-scope", ".pi", "agents");
    writeAgent(projectDir, "c.md", { name: "coder", description: "Code" }, "C");

    // discoverAgents uses ~/.pi/agent/agents for user scope — we can't override that
    // So test with a cwd that has no project agents and verify scope behavior
    const result = discoverAgents(makeDir("empty-cwd"), "user");
    // Repo dirs are found but not loaded under this scope; the real user dir is out of test control
    expect(result.projectDirs).toEqual({ neutral: null, pi: null });
  });

  test("scope=project loads only project agents", () => {
    const agentsDir = makeDir("proj", ".pi", "agents");
    writeAgent(agentsDir, "local.md", { name: "local", description: "Local agent" }, "L");

    const projectRoot = makeDir("proj");
    const result = discoverAgents(projectRoot, "project");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe("local");
    expect(result.agents[0].source).toBe("project");
  });

  test("scope=both merges user and project agents", () => {
    const agentsDir = makeDir("both", ".pi", "agents");
    writeAgent(agentsDir, "p1.md", { name: "proj-agent", description: "P" }, "P");

    const projectRoot = makeDir("both");
    const result = discoverAgents(projectRoot, "both");
    // May include real user agents from ~/.pi/agent/agents if they exist
    const projectAgent = result.agents.find((a) => a.name === "proj-agent");
    expect(projectAgent).toBeDefined();
    expect(projectAgent?.source).toBe("project");
  });

  test("project agents override user agents with same name (scope=both)", () => {
    const agentsDir = makeDir("override", ".pi", "agents");
    writeAgent(agentsDir, "dupe.md", { name: "researcher", description: "Project version" }, "P");

    const projectRoot = makeDir("override");
    const result = discoverAgents(projectRoot, "both");
    const researcher = result.agents.find((a) => a.name === "researcher");
    // If user has a real researcher agent, project should still win
    if (researcher) {
      expect(researcher.source).toBe("project");
    }
  });

  test("scope=user excludes repo agents but still reports the dirs", () => {
    const neutral = makeDir("user-scope", ".agents", "agents");
    writeAgent(neutral, "r.md", { name: "repo-only", description: "R" }, "R");

    const result = discoverAgents(makeDir("user-scope"), "user");
    expect(result.agents.find((a) => a.name === "repo-only")).toBeUndefined();
    expect(result.projectDirs.neutral).toBe(neutral);
  });

  test("pi-specific overrides neutral in the same root", () => {
    const neutral = makeDir("merge", ".agents", "agents");
    writeAgent(neutral, "n.md", { name: "dup", description: "neutral" }, "N");
    const pi = makeDir("merge", ".pi", "agents");
    writeAgent(pi, "p.md", { name: "dup", description: "pi" }, "P");

    const result = discoverAgents(makeDir("merge"), "project");
    expect(result.agents.find((a) => a.name === "dup")?.description).toBe("pi");
  });

  test("notes agents load in every scope and override repo agents", () => {
    const notesDir = makeDir("notes-root");
    const project = makeDir("notes-proj");
    const repoPi = makeDir("notes-proj", ".pi", "agents");
    writeAgent(repoPi, "r.md", { name: "helper", description: "repo" }, "R");
    const notesPi = makeDir("notes-root", "notes-proj", ".pi", "agents");
    writeAgent(notesPi, "n.md", { name: "helper", description: "notes" }, "N");

    const result = discoverAgents(project, "both", notesDir);
    const helper = result.agents.find((a) => a.name === "helper");
    expect(helper?.description).toBe("notes");
    expect(helper?.source).toBe("notes");
    expect(result.notesDirs.pi).toBe(notesPi);
  });

  test("notes neutral loads when no pi-specific dir exists", () => {
    const notesDir = makeDir("notes-root-neutral");
    const neutral = makeDir("notes-root-neutral", "plain", ".agents", "agents");
    writeAgent(neutral, "p.md", { name: "planner", description: "plan" }, "P");

    const result = discoverAgents(makeDir("plain"), "user", notesDir);
    expect(result.agents.find((a) => a.name === "planner")?.source).toBe("notes");
  });

  test("notes agents load under scope=project", () => {
    const notesDir = makeDir("notes-scope-project");
    const neutral = makeDir("notes-scope-project", "scope-project", ".agents", "agents");
    writeAgent(neutral, "v.md", { name: "scope-notes", description: "V" }, "V");

    const result = discoverAgents(makeDir("scope-project"), "project", notesDir);
    expect(result.agents.find((a) => a.name === "scope-notes")?.source).toBe("notes");
  });

  test("notes resolve through a worktree to the main project", () => {
    const notesDir = makeDir("notes-root-wt");
    const neutral = makeDir("notes-root-wt", "bar-project", ".agents", "agents");
    writeAgent(neutral, "v.md", { name: "verifier", description: "prose" }, "V");
    const worktree = join(TEST_DIR, "src", "bar-project.worktrees", "feat", "branch");
    mkdirSync(worktree, { recursive: true });

    const result = discoverAgents(worktree, "user", notesDir);
    expect(result.agents.find((a) => a.name === "verifier")?.source).toBe("notes");
    expect(result.notesDirs.neutral).toBe(neutral);
  });
});

// ── buildToolDescription ──

describe("buildToolDescription", () => {
  test("includes header lines for empty agents", () => {
    const desc = buildToolDescription([]);
    expect(desc).toContain("Delegate tasks to specialized subagents");
    expect(desc).toContain('agentScope: "both"');
    expect(desc).toContain("No agents defined");
  });

  test("lists agents with tools and role", () => {
    const agents: AgentConfig[] = [
      {
        name: "researcher",
        description: "Investigates codebases",
        tools: ["read", "grep"],
        role: "explain",
        systemPrompt: "",
        source: "user",
        filePath: "/fake/researcher.md",
      },
    ];
    const desc = buildToolDescription(agents);
    expect(desc).toContain("- researcher: Investigates codebases [read, grep], role: explain");
  });

  test("names a pinned model and its level instead of the role", () => {
    const agents: AgentConfig[] = [
      {
        name: "pinned",
        description: "One model",
        model: "openrouter/x/y",
        thinking: "low",
        role: "explain",
        systemPrompt: "",
        source: "user",
        filePath: "/fake/pinned.md",
      },
    ];
    const desc = buildToolDescription(agents);
    expect(desc).toContain("- pinned: One model, model: openrouter/x/y, thinking: low");
    expect(desc).not.toContain("role: explain");
  });

  test("shows a thinking override on a role-based agent", () => {
    const agents: AgentConfig[] = [
      {
        name: "thinker",
        description: "Reasons",
        role: "explain",
        thinking: "max",
        systemPrompt: "",
        source: "user",
        filePath: "/fake/thinker.md",
      },
    ];
    expect(buildToolDescription(agents)).toContain(", role: explain, thinking: max");
  });

  test("omits tools/role when absent", () => {
    const agents: AgentConfig[] = [
      {
        name: "basic",
        description: "Simple agent",
        systemPrompt: "",
        source: "user",
        filePath: "/fake/basic.md",
      },
    ];
    const desc = buildToolDescription(agents);
    expect(desc).toContain("- basic: Simple agent");
    expect(desc).not.toContain("[");
    expect(desc).not.toContain("role:");
  });
});

// ── projectRootOf / respectProjectTrust ──

describe("projectRootOf", () => {
  test("returns the level above both kinds", () => {
    expect(projectRootOf({ neutral: "/repo/.agents/agents", pi: null })).toBe("/repo");
    expect(projectRootOf({ neutral: null, pi: "/repo/.pi/agents" })).toBe("/repo");
    expect(projectRootOf({ neutral: "/repo/.agents/agents", pi: "/repo/.pi/agents" })).toBe("/repo");
  });

  test("returns null when no dir was found", () => {
    expect(projectRootOf({ neutral: null, pi: null })).toBeNull();
  });
});

describe("respectProjectTrust", () => {
  const agent = (name: string, source: AgentConfig["source"]): AgentConfig => ({
    name,
    description: "",
    systemPrompt: "",
    source,
    filePath: "",
  });

  test("drops repo agents when the project is not trusted", () => {
    const agents = [agent("u", "user"), agent("p", "project"), agent("n", "notes")];
    expect(respectProjectTrust(agents, false).map((a) => a.name)).toEqual(["u", "n"]);
  });

  test("keeps every source when trusted", () => {
    const agents = [agent("u", "user"), agent("p", "project"), agent("n", "notes")];
    expect(respectProjectTrust(agents, true).map((a) => a.name)).toEqual(["u", "p", "n"]);
  });
});

// ── expandIncludes ──

describe("expandIncludes", () => {
  const dir = () => makeDir("includes");

  test("splices a fragment from the agent's own directory", () => {
    const d = dir();
    mkdirSync(join(d, "rules"), { recursive: true });
    writeFileSync(join(d, "rules", "rule.md"), "RULE TEXT\n");
    expect(expandIncludes("before\n@rules/rule.md\nafter", d)).toBe("before\nRULE TEXT\n\nafter");
  });

  test("a missing fragment throws instead of dropping the rule", () => {
    expect(() => expandIncludes("@rules/nope.md", dir())).toThrow(/include not found/);
  });

  test("a directive inside a fenced block stays literal", () => {
    const d = dir();
    mkdirSync(join(d, "rules"), { recursive: true });
    writeFileSync(join(d, "rules", "rule.md"), "RULE TEXT\n");
    expect(expandIncludes("```\n@rules/rule.md\n```", d)).toBe("```\n@rules/rule.md\n```");
  });

  test("a fragment that includes another fragment throws", () => {
    const d = dir();
    mkdirSync(join(d, "rules"), { recursive: true });
    writeFileSync(join(d, "rules", "outer.md"), "@rules/inner.md\n");
    expect(() => expandIncludes("@rules/outer.md", d)).toThrow(/do not nest/);
  });

  test("a fragment may document the directive inside a fence", () => {
    const d = dir();
    mkdirSync(join(d, "rules"), { recursive: true });
    writeFileSync(join(d, "rules", "doc.md"), "Use a line like:\n\n```\n@rules/other.md\n```\n");
    expect(expandIncludes("@rules/doc.md", d)).toContain("@rules/other.md");
  });
});

describe("a loaded agent", () => {
  test("carries the fragment text, not the directive", () => {
    const d = makeDir("loaded");
    mkdirSync(join(d, "rules"), { recursive: true });
    writeFileSync(join(d, "rules", "rule.md"), "RULE TEXT\n");
    writeAgent(d, "a.md", { name: "a", description: "d" }, "before\n@rules/rule.md\nafter");
    expect(loadAgentsFromDir(d, "user")[0].systemPrompt).toBe("before\nRULE TEXT\n\nafter");
  });

  test("resolves through a symlinked agent directory", () => {
    // The fragment sits above the symlink's target, so only the real path reaches it:
    // <real>/rules/rule.md, agent at <real>/sub/agents/a.md, symlink -> <real>/sub.
    const real = makeDir("real");
    mkdirSync(join(real, "rules"), { recursive: true });
    writeFileSync(join(real, "rules", "rule.md"), "RULE TEXT\n");
    const sub = makeDir("real", "sub", "agents");
    writeAgent(sub, "a.md", { name: "a", description: "d" }, "@rules/rule.md");
    const linked = join(TEST_DIR, "linked-agents");
    symlinkSync(join(real, "sub"), linked);
    expect(loadAgentsFromDir(join(linked, "agents"), "user")[0].systemPrompt).toBe("RULE TEXT\n");
  });
});

// ── every deployed directive resolves ──

describe("deployed @rules directives", () => {
  const llmDir = join(import.meta.dir, "..", "..", "..");
  const agentDir = join(llmDir, "pi", "agents");
  const targets = [
    join(llmDir, "instructions.md"),
    ...readdirSync(agentDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(agentDir, name)),
  ];
  const directives = (file: string) =>
    readFileSync(file, "utf-8")
      .split("\n")
      .map((line) => line.trim().match(/^@(rules\/[A-Za-z0-9._-]+\.md)$/)?.[1])
      .filter((name): name is string => Boolean(name));

  test("the loader expands each named fragment and leaves no directive", () => {
    for (const file of targets) {
      const out = expandIncludes(readFileSync(file, "utf-8"), dirname(file));
      expect(out).not.toMatch(/^@rules\//m);
      for (const name of directives(file)) {
        const first = readFileSync(join(llmDir, name), "utf-8").split("\n")[0].slice(0, 40);
        expect(out).toContain(first);
      }
    }
  });

  test("the reviewer keeps all five fragments", () => {
    expect(directives(join(agentDir, "reviewer.md"))).toEqual([
      "rules/prose.md",
      "rules/comments.md",
      "rules/private-content.md",
      "rules/tests.md",
      "rules/message.md",
    ]);
  });

  test("the instructions name every fragment", () => {
    const named = directives(join(llmDir, "instructions.md")).sort();
    const files = readdirSync(join(llmDir, "rules"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `rules/${name}`)
      .sort();
    expect(named).toEqual(files);
  });
});

// ── workerAgent ──

describe("workerAgent", () => {
  const build = (spec: unknown) => {
    const result = workerAgent(spec);
    if ("error" in result) throw new Error(`expected an agent, got: ${result.error}`);
    return result.agent;
  };
  const errorOf = (spec: unknown) => {
    const result = workerAgent(spec);
    if ("agent" in result) throw new Error("expected an error, got an agent");
    return result.error;
  };

  test("builds a worker from instructions alone", () => {
    const agent = build({ instructions: "You check a change against its task." });
    expect(agent.name).toBe("worker");
    expect(agent.source).toBe("ad-hoc");
    expect(agent.systemPrompt).toBe("You check a change against its task.");
    expect(agent.filePath).toBeUndefined();
  });

  test("sandboxes the shell by default", () => {
    expect(build({ instructions: "x" }).extensions).toEqual(["sandbox-bash"]);
    expect(build({ instructions: "x", bash: "sandboxed" }).extensions).toEqual(["sandbox-bash"]);
  });

  test("a normal shell adds no extension", () => {
    expect(build({ instructions: "x", bash: "normal" }).extensions).toBeUndefined();
  });

  test("refuses a field the spec does not own", () => {
    const error = errorOf({ instructions: "x", model: "acme/model-1" });
    expect(error).toContain("spec.model");
    expect(error).toContain("instructions and bash only");
  });

  test("refuses empty instructions", () => {
    expect(errorOf({ instructions: "   " })).toContain("non-empty string");
    expect(errorOf({})).toContain("non-empty string");
    expect(errorOf({ instructions: 42 })).toContain("non-empty string");
  });

  test("refuses an unknown shell value", () => {
    expect(errorOf({ instructions: "x", bash: "readonly" })).toBe('spec.bash must be "sandboxed" or "normal".');
  });

  test("refuses a spec that is not an object", () => {
    for (const spec of [null, "instructions", ["x"]]) {
      expect(errorOf(spec)).toContain("spec must be an object");
    }
  });
});

// ── markShadowed ──

describe("markShadowed", () => {
  const agent = (name: string): AgentConfig => ({
    name,
    description: "",
    systemPrompt: "",
    source: "user",
    filePath: "",
  });

  test("a later section shadows an earlier name", () => {
    expect(markShadowed([[agent("x")], [agent("x")]])).toEqual([[true], [false]]);
  });

  test("a later dir in the same section shadows an earlier name", () => {
    expect(markShadowed([[agent("x"), agent("x")]])).toEqual([[true, false]]);
  });

  test("a name in all three sections leaves only the top one unmarked", () => {
    expect(markShadowed([[agent("x")], [agent("x")], [agent("x")]])).toEqual([[true], [true], [false]]);
  });

  test("distinct names are never marked", () => {
    expect(markShadowed([[agent("a")], [agent("b")]])).toEqual([[false], [false]]);
  });
});
