import { describe, expect, test } from "bun:test";
import type { AgentConfig, AgentDirs } from "./agents";
import { repoGate } from "./repo-gate";

const agent = (name: string, source: AgentConfig["source"]): AgentConfig => ({
  name,
  description: "",
  systemPrompt: "",
  source,
  filePath: "",
});

const dirs: AgentDirs = { neutral: "/repo/.agents/agents", pi: "/repo/.pi/agents" };
const base = {
  agentScope: "both" as const,
  trusted: true,
  hasUI: true,
  accepted: () => false,
  projectDirs: dirs,
};

describe("repoGate", () => {
  test("blocks a requested repo agent when the project is untrusted", () => {
    const repo = agent("coder", "project");
    expect(
      repoGate({
        ...base,
        trusted: false,
        discovered: [repo],
        requestedNames: ["coder"],
      }),
    ).toEqual({ kind: "block", names: ["coder"] });
  });

  test("untrusted passes a name the repo dirs do not define", () => {
    expect(
      repoGate({
        ...base,
        trusted: false,
        discovered: [agent("personal", "notes")],
        requestedNames: ["personal"],
      }),
    ).toEqual({ kind: "pass" });
  });

  test("a notes agent shadowing a repo name runs when untrusted", () => {
    // The merged discovery keeps only the notes entry for that name.
    expect(
      repoGate({
        ...base,
        trusted: false,
        discovered: [agent("helper", "notes")],
        requestedNames: ["helper"],
      }),
    ).toEqual({ kind: "pass" });
  });

  test("confirms a requested repo agent, and an accepted root passes", () => {
    const repo = agent("coder", "project");
    const input = { ...base, discovered: [repo], requestedNames: ["coder"] };
    expect(repoGate(input)).toEqual({
      kind: "confirm",
      names: ["coder"],
      dirs: ["/repo/.agents/agents", "/repo/.pi/agents"],
      root: "/repo",
    });
    expect(repoGate({ ...input, accepted: (root) => root === "/repo" })).toEqual({ kind: "pass" });
  });

  test("no UI, user scope, and unrequested names pass without confirming", () => {
    const repo = agent("coder", "project");
    const input = { ...base, discovered: [repo], requestedNames: ["coder"] };
    expect(repoGate({ ...input, hasUI: false })).toEqual({ kind: "pass" });
    expect(repoGate({ ...input, agentScope: "user" })).toEqual({ kind: "pass" });
    expect(repoGate({ ...input, requestedNames: ["other"] })).toEqual({ kind: "pass" });
  });

  test("a requested user or notes agent passes", () => {
    expect(repoGate({ ...base, discovered: [agent("u", "user")], requestedNames: ["u"] })).toEqual({
      kind: "pass",
    });
  });
});
