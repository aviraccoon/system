import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentDirs } from "./agents";
import { type DispatchFacts, planDispatch } from "./dispatch";

const agent = (name: string, source: AgentConfig["source"]): AgentConfig => ({
  name,
  description: "",
  systemPrompt: "",
  source,
  filePath: "",
});

const dirs: AgentDirs = { neutral: "/repo/.agents/agents", pi: null };

function facts(overrides: Partial<DispatchFacts> = {}): DispatchFacts {
  return {
    discovered: [],
    agents: [],
    agentScope: "user",
    trusted: false,
    hasUI: true,
    accepted: () => false,
    projectDirs: dirs,
    cwd: "/repo",
    ...overrides,
  };
}

describe("planDispatch", () => {
  test("a worker runs from the dispatch's own config, not a discovered one", () => {
    const plan = planDispatch({ spec: { instructions: "check it" }, task: "go", cwd: "/tmp" }, facts());
    if (plan.kind !== "run") throw new Error(plan.text);
    expect(plan.mode).toBe("single");
    expect(plan.runAgents.map((a) => a.name)).toEqual(["worker"]);
    expect(plan.runAgents[0].source).toBe("ad-hoc");
    expect(plan.singleAgent).toBe("worker");
    expect(plan.singleTask).toBe("go");
    expect(plan.singleCwd).toBe("/tmp");
  });

  test("a worker never asks to confirm a repo agent with its name", () => {
    const plan = planDispatch(
      { spec: { instructions: "check it" }, task: "go", agentScope: "both" },
      facts({ discovered: [agent("worker", "project")], trusted: true, agentScope: "both" }),
    );
    if (plan.kind !== "run") throw new Error(plan.text);
    expect(plan.confirm).toBeUndefined();
    expect(plan.runAgents.map((a) => a.name)).toEqual(["worker"]);
  });

  test("an invalid spec is refused instead of being read as another mode", () => {
    const plan = planDispatch(
      { spec: { instructions: "", model: "acme/m" }, task: "go", tasks: [{ agent: "researcher", task: "x" }] },
      facts(),
    );
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    expect(plan.text).toContain("Invalid spec:");
    expect(plan.text).toContain("spec.model");
  });

  test("a spec combined with a named agent is refused", () => {
    const plan = planDispatch({ spec: { instructions: "x" }, task: "go", agent: "researcher" }, facts());
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    expect(plan.text).toContain("takes task and no agent");
  });

  test("a spec with no task is refused", () => {
    const plan = planDispatch({ spec: { instructions: "x" } }, facts());
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    expect(plan.text).toContain("spec needs a task");
  });

  test("a repo agent in an untrusted project is refused", () => {
    const plan = planDispatch(
      { agent: "researcher", task: "go", agentScope: "both" },
      facts({ discovered: [agent("researcher", "project")], trusted: false }),
    );
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    expect(plan.text).toContain("project trust is not granted");
    expect(plan.mode).toBe("single");
  });

  test("a trusted repo agent asks once per repository", () => {
    const plan = planDispatch(
      { agent: "researcher", task: "go", agentScope: "both" },
      facts({
        discovered: [agent("researcher", "project")],
        agents: [agent("researcher", "project")],
        trusted: true,
        agentScope: "both",
      }),
    );
    if (plan.kind !== "run") throw new Error(plan.text);
    expect(plan.confirm).toEqual({
      kind: "confirm",
      names: ["researcher"],
      dirs: ["/repo/.agents/agents"],
      root: "/repo",
    });
  });

  test("an accepted repo root runs without asking", () => {
    const plan = planDispatch(
      { agent: "researcher", task: "go", agentScope: "both" },
      facts({
        discovered: [agent("researcher", "project")],
        agents: [agent("researcher", "project")],
        trusted: true,
        agentScope: "both",
        accepted: (root) => root === "/repo",
      }),
    );
    if (plan.kind !== "run") throw new Error(plan.text);
    expect(plan.confirm).toBeUndefined();
    expect(plan.singleAgent).toBe("researcher");
    expect(plan.runAgents.map((a) => a.name)).toEqual(["researcher"]);
  });

  test("a call with no mode is refused before the repo gate", () => {
    const plan = planDispatch(
      { agent: "researcher", agentScope: "both" },
      facts({ discovered: [agent("researcher", "project")], trusted: false }),
    );
    if (plan.kind !== "refuse") throw new Error("expected a refusal");
    expect(plan.text).toContain("exactly one mode");
  });

  test("a chain runs the discovered agents step by step", () => {
    const plan = planDispatch(
      {
        chain: [
          { agent: "a", task: "x" },
          { agent: "b", task: "y {previous}" },
        ],
      },
      facts({ agents: [agent("a", "user"), agent("b", "user")] }),
    );
    if (plan.kind !== "run") throw new Error(plan.text);
    expect(plan.mode).toBe("chain");
    expect(plan.singleAgent).toBeUndefined();
    expect(plan.runAgents.map((a) => a.name)).toEqual(["a", "b"]);
  });

  test("a parallel batch runs every discovered agent", () => {
    const plan = planDispatch(
      {
        tasks: [
          { agent: "a", task: "x" },
          { agent: "b", task: "y" },
        ],
      },
      facts({ agents: [agent("a", "user"), agent("b", "user")] }),
    );
    if (plan.kind !== "run") throw new Error(plan.text);
    expect(plan.mode).toBe("parallel");
    expect(plan.parallelTasks).toHaveLength(2);
    expect(plan.runAgents.map((a) => a.name)).toEqual(["a", "b"]);
  });
});
