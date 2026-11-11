/**
 * Wiring test for the guard: what the agent receives at the start of a turn, and
 * what the floor refuses. The policy path and the decision model are injected
 * (`EnvGuardOverrides`), so this runs without a pi session, a network call or the
 * notes tree.
 *
 * It exists because the wiring is where the silent failures live: dropping the
 * `ctx.cwd` argument to `refusalText` restores a nested `cd` in the replacement,
 * and a policy the agent can edit is a policy that is not enforced at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { DecisionsAnswer } from "../shared/decisions";
import type { PolicyAsk } from "../shared/env-policy";
import { FILE_LIMIT, parseDecisions } from "./decisions";
import envGuardExtension from "./index";

const POLICY = {
  project: "acme-widgets",
  environment: "the devcontainer",
  binding: {
    command: "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    workdir: "/workspaces/acme-widgets/app",
  },
  clauses: [{ id: "deps", text: "Dependency work runs in the devcontainer." }],
};

let dir = "";
let policyFile = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "env-guard-"));
  policyFile = join(dir, ".agents", "environment.json");
  mkdirSync(dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, JSON.stringify(POLICY));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The judge's answers, injected so no test needs a network call. */
const ASK: PolicyAsk = async (questions) => {
  const answers: Record<string, DecisionsAnswer> = {};
  if ("policy_violation" in questions) answers.policy_violation = { type: "noul", noul: 0.95 };
  else answers.policy_clause = { type: "choice", choice: "deps", probabilities: { deps: 0.9 } };
  return answers;
};

/** A judge that clears everything: for the allowed side of the record. */
const CLEARS: PolicyAsk = async (questions) => {
  const answers: Record<string, DecisionsAnswer> = {};
  if ("policy_violation" in questions) answers.policy_violation = { type: "noul", noul: 0.05 };
  else answers.policy_clause = { type: "choice", choice: "deps", probabilities: { deps: 0.9 } };
  return answers;
};

interface Guard {
  fire(event: string, payload?: unknown): Promise<unknown>;
  command(name: string, args: string): Promise<void>;
  /** Call a registered tool by name and return its text output. */
  tool(name: string): Promise<string>;
  /** Notifications the extension sent through `ctx.ui.notify`. */
  notices: string[];
}

/** A loaded extension instance whose `pi` records every handler, so a test can drive any event. */
async function started(
  cwd: string,
  sessionId = "s-test",
  ask: PolicyAsk = ASK,
  decisionsPath: string = join(dir, "env-guard.log"),
): Promise<Guard> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  interface Tool {
    execute: (
      id: string,
      params: unknown,
      signal: unknown,
      update: unknown,
      ctx: unknown,
    ) => Promise<{ content: { text: string }[] }>;
  }
  type FakeTool = Pick<ToolDefinition<TSchema>, "name" | "parameters"> & Tool;
  const tools = new Map<string, Tool>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, definition);
    },
    registerTool: (tool: FakeTool) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
    modelRegistry: {},
    sessionManager: { getSessionId: () => sessionId },
    signal: undefined,
  } as unknown as ExtensionContext;
  const notices: string[] = [];

  envGuardExtension(pi, { ask, policyPath: () => policyFile, decisionsPath });
  await handlers.get("session_start")?.({}, ctx);
  return {
    fire: async (event, payload) => handlers.get(event)?.(payload ?? {}, ctx),
    command: async (name, args) => {
      const definition = commands.get(name);
      if (!definition) throw new Error(`no command ${name}`);
      await definition.handler(args, ctx);
    },
    tool: async (name) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`no tool ${name}`);
      const result = await tool.execute("call-1", {}, undefined, undefined, ctx);
      return result.content.map((part) => part.text).join("\n");
    },
    notices,
  };
}

/** Run one bash tool call through the extension and return the block reason. */
async function blockReason(command: string, cwd: string): Promise<string | undefined> {
  const guard = await started(cwd);
  const result = (await guard.fire("tool_call", { toolName: "bash", input: { command } })) as
    | { block?: boolean; reason?: string }
    | undefined;
  expect(result?.block).toBe(true);
  return result?.reason;
}

describe("tool_call floor", () => {
  test("the refusal reaches the agent with the clause and a wrapping replacement", async () => {
    const reason = await blockReason("pnpm install --frozen-lockfile", "/Users/acme/acme-widgets");
    expect(reason).toContain("[env-guard] refused");
    expect(reason).toContain("clause deps:");
    expect(reason).toContain("sh -lc 'pnpm install --frozen-lockfile'");
  });

  test("the host cwd reaches the refusal text, so a leading cd into the workdir is dropped", async () => {
    const reason = await blockReason("cd app && pnpm install", "/Users/acme/acme-widgets");
    expect(reason).toContain("sh -lc 'pnpm install'");
    expect(reason).not.toContain("cd app");
  });

  test("a host cwd that does not mirror the workdir's parent keeps the cd", async () => {
    // Same command, a cwd that does not mirror the workdir's parent.
    const reason = await blockReason("cd app && pnpm install", "/Users/acme/widgets/frontend");
    expect(reason).toContain("sh -lc 'cd app && pnpm install'");
  });

  test("the refusal names the file the rules live in, so a wrong clause is reportable", async () => {
    const reason = await blockReason("pnpm install", "/Users/acme/acme-widgets");
    expect(reason).toContain(`Rules: ${policyFile}`);
    expect(reason).toContain("the user's to change");
  });
});

describe("rules in context", () => {
  test("the first turn carries the policy, rendered from the file the judge reads", async () => {
    const guard = await started("/Users/acme/acme-widgets");
    const result = (await guard.fire("before_agent_start")) as
      | { message?: { content?: string; display?: boolean } }
      | undefined;
    expect(result?.message?.content).toContain("enforced by pi's env-guard");
    expect(result?.message?.content).toContain("- deps: Dependency work runs in the devcontainer.");
    expect(result?.message?.content).toContain(policyFile);
    expect(result?.message?.display).toBe(false);
  });

  test("it is sent once, so a later turn does not carry a second copy", async () => {
    const guard = await started("/Users/acme/acme-widgets");
    expect(await guard.fire("before_agent_start")).toBeDefined();
    expect(await guard.fire("before_agent_start")).toBeUndefined();
  });

  test("compaction summarizes the block away, so the next turn carries it again", async () => {
    const guard = await started("/Users/acme/acme-widgets");
    expect(await guard.fire("before_agent_start")).toBeDefined();
    await guard.fire("session_before_compact");
    expect(await guard.fire("before_agent_start")).toBeDefined();
  });

  test("a project without a policy carries nothing, because nothing can be refused", async () => {
    rmSync(policyFile, { force: true });
    const guard = await started("/Users/acme/acme-widgets");
    expect(await guard.fire("before_agent_start")).toBeUndefined();
  });
});

describe("the policy is not the agent's to write", () => {
  test("a patch on the policy is refused before it runs", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "patch",
      input: { path: policyFile, edits: [{ oldText: "a", newText: "b" }] },
    })) as { block?: boolean; reason?: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("the user's to edit");
  });

  test("a relative path from the project root names the same file", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: join(".agents", "environment.json") },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("a session grant does not unlock it", async () => {
    const guard = await started(dir);
    await guard.command("guard", "allow");
    const result = (await guard.fire("tool_call", {
      toolName: "patch",
      input: { path: policyFile, edits: [{ oldText: "a", newText: "b" }] },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("a policy that does not parse is still not the agent's to rewrite", async () => {
    writeFileSync(policyFile, '{"project":""}');
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "patch",
      input: { path: policyFile, edits: [{ oldText: "a", newText: "b" }] },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("a bash write naming the policy is refused", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "bash",
      input: { command: `printf '{}' > ${policyFile}` },
    })) as { block?: boolean; reason?: string } | undefined;
    expect(result?.block).toBe(true);
    // The shell reason, not the write reason: a command naming a policy is refused whatever it does.
    expect(result?.reason).toContain("does not parse shell");
  });

  test("a shell command naming the policy is refused whether it reads or writes, and says so", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "bash",
      input: { command: `cat ${policyFile}` },
    })) as { block?: boolean; reason?: string } | undefined;
    expect(result?.block).toBe(true);
    // The reason must describe the rule that fired: no shell parsing, use the read tool.
    expect(result?.reason).toContain("does not parse shell");
    expect(result?.reason).toContain("read tool");
  });

  test("the shell branch folds case too, since a case variant names the same file", async () => {
    const guard = await started(dir);
    const mangled = policyFile.replace("environment.json", "Environment.JSON");
    const result = (await guard.fire("tool_call", { toolName: "bash", input: { command: `cat ${mangled}` } })) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("does not parse shell");
  });

  test("a case variant is the same file on a case-insensitive filesystem", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: join(".agents", "Environment.json") },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("a case variant is refused where no policy exists yet, so the name check is case-folded", async () => {
    // With no file to resolve, `realpathSync` throws and the name check decides. Bun's realpath
    // canonicalizes the case of an existing file, so this is the only case that pins the fold.
    rmSync(policyFile, { force: true });
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: join(".agents", "Environment.json") },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("a symlink to the policy is the policy", async () => {
    const alias = join(dir, "alias.json");
    symlinkSync(policyFile, alias);
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", { toolName: "write", input: { path: alias } })) as
      | { block?: boolean }
      | undefined;
    expect(result?.block).toBe(true);
  });

  test("/guard off turns the floor off with everything else", async () => {
    const guard = await started(dir);
    await guard.command("guard", "off");
    const result = await guard.fire("tool_call", {
      toolName: "patch",
      input: { path: policyFile, edits: [{ oldText: "a", newText: "b" }] },
    });
    expect(result).toBeUndefined();
  });

  test("/guard status says the floor still applies where no policy loads", async () => {
    rmSync(policyFile, { force: true });
    const guard = await started(dir);
    await guard.command("guard", "status");
    // The status line is the user's account of why a call was refused; it must not say nothing is.
    expect(guard.notices.join("\n")).toContain("only the policy file itself is refused");
    // With the guard off, the policy file is not floored either, and the line must not claim it is.
    await guard.command("guard", "off");
    guard.notices.length = 0;
    await guard.command("guard", "status");
    const offStatus = guard.notices.join("\n");
    expect(offStatus).toContain("the guard is off, so nothing is refused");
    expect(offStatus).not.toContain("only the policy file itself is refused");
  });

  test("a leading @ is resolved the way the write tools resolve it", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: "@.agents/environment.json" },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("a session in a project without a policy cannot rewrite another project's", async () => {
    // No policy file in this cwd; the rule is about the file, not about enforcement.
    rmSync(policyFile, { force: true });
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: policyFile },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("another file in the project is left alone", async () => {
    const guard = await started(dir);
    const result = await guard.fire("tool_call", {
      toolName: "patch",
      input: { path: join(dir, "README.md"), edits: [{ oldText: "a", newText: "b" }] },
    });
    expect(result).toBeUndefined();
  });

  test("the read tool is the way in, so reading the policy passes", async () => {
    // The shell refusal tells the agent to read the file; if the floor also refused the read tool,
    // that advice would be a dead end.
    const guard = await started(dir);
    const result = await guard.fire("tool_call", { toolName: "read", input: { path: policyFile } });
    expect(result).toBeUndefined();
  });
});

describe("env_policy tool", () => {
  test("reports the rules, the session state and what was judged, without the probability", async () => {
    const guard = await started(dir);
    await guard.fire("tool_call", { toolName: "bash", input: { command: "pnpm install" } });
    const text = await guard.tool("env_policy");
    expect(text).toContain("enforced by pi's env-guard");
    expect(text).toContain("state: on; host grant: not given");
    expect(text).toContain("judged in this session (newest 1):");
    expect(text).toContain("refused  pnpm install -> deps");
    // The judge answered 0.95; that number belongs to the file, not to the agent.
    expect(text).not.toContain("0.95");
  });

  test("the log keeps the probability and records a cleared call, which the view hides", async () => {
    const guard = await started(dir, "s-log", CLEARS);
    await guard.fire("tool_call", { toolName: "bash", input: { command: "git status" } });
    const records = parseDecisions(readFileSync(join(dir, "env-guard.log"), "utf-8"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ violated: false, probability: 0.05, threshold: 0.65, session: "s-log" });
    const text = await guard.tool("env_policy");
    expect(text).toContain("- allowed  git status");
    expect(text).not.toContain("0.05");
  });

  test("an unwritable log does not stop the refusal", async () => {
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "a file where the log's directory would be");
    const guard = await started(dir, "s-test", ASK, join(blocked, "env-guard.log"));
    const result = (await guard.fire("tool_call", { toolName: "bash", input: { command: "pnpm install" } })) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("clause deps");
  });

  test("scopes the history to this session", async () => {
    const first = await started(dir, "s-first");
    await first.fire("tool_call", { toolName: "bash", input: { command: "pnpm install" } });
    const second = await started(dir, "s-second");
    const text = await second.tool("env_policy");
    expect(text).toContain("judged in this session: none yet");
    expect(text).not.toContain("pnpm install");
  });

  test("trims the log at session start, and leaves a short one alone", async () => {
    const line = (index: number) =>
      `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", session: "old", project: "acme", kind: "policy", command: `cmd-${index}`, violated: true, clause: "deps", probability: 0.9, threshold: 0.65 })}\n`;
    writeFileSync(
      join(dir, "env-guard.log"),
      Array.from({ length: FILE_LIMIT + 1 }, (_, index) => line(index)).join(""),
    );
    await started(dir);
    const kept = parseDecisions(readFileSync(join(dir, "env-guard.log"), "utf-8"));
    expect(kept).toHaveLength(FILE_LIMIT);
    expect(kept.at(-1)?.command).toBe(`cmd-${FILE_LIMIT}`);
    // A file under the limit is left byte-identical.
    const short = line(1) + line(2);
    writeFileSync(join(dir, "env-guard.log"), short);
    await started(dir);
    expect(readFileSync(join(dir, "env-guard.log"), "utf-8")).toBe(short);
  });

  test("another window's records cannot push this session's out of the view", async () => {
    const line = (session: string, command: string) =>
      `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", session, project: "acme", kind: "policy", command, violated: true, clause: "deps", probability: 0.9, threshold: 0.65 })}\n`;
    // This session's record first, then enough of another window's to fill any tail window.
    const mine = line("s-mine", "pnpm install");
    const others = Array.from({ length: 600 }, (_, index) => line("other", `other-${index}`)).join("");
    writeFileSync(join(dir, "env-guard.log"), mine + others);
    const guard = await started(dir, "s-mine");
    expect(await guard.tool("env_policy")).toContain("refused  pnpm install -> deps");
  });

  test("reports a session grant", async () => {
    const guard = await started(dir);
    await guard.command("guard", "allow");
    expect(await guard.tool("env_policy")).toContain("host grant: given for this session");
  });

  test("records a policy-file write under its own reason, with the path it targeted", async () => {
    const guard = await started(dir);
    await guard.fire("tool_call", { toolName: "write", input: { path: policyFile } });
    expect(await guard.tool("env_policy")).toContain("refused (policy file write)");
    // The floor refusal carries no clause, and the view must say so rather than render null.
    expect(await guard.tool("env_policy")).toContain("-> no clause cited");
    // The record names the target, not the tool: a clipped path still starts with the path.
    const records = parseDecisions(readFileSync(join(dir, "env-guard.log"), "utf-8"));
    expect(records[0]?.command.startsWith(policyFile.slice(0, 60))).toBe(true);
  });

  test("records a shell command naming the policy under its own reason", async () => {
    const guard = await started(dir);
    await guard.fire("tool_call", { toolName: "bash", input: { command: `cat ${policyFile}` } });
    const text = await guard.tool("env_policy");
    expect(text).toContain("refused (policy file named in shell)");
  });

  test("reports the guard as off when it is", async () => {
    const guard = await started(dir);
    await guard.command("guard", "off");
    expect(await guard.tool("env_policy")).toContain("state: off");
  });

  test("reports a policy's parse errors instead of its rules", async () => {
    writeFileSync(policyFile, '{"project":""}');
    const guard = await started(dir);
    const text = await guard.tool("env_policy");
    expect(text).toContain("No usable environment policy at");
    expect(text).toContain("errors:");
  });

  test("says so when no policy loaded, rather than rendering an empty block", async () => {
    rmSync(policyFile, { force: true });
    const guard = await started(dir);
    const text = await guard.tool("env_policy");
    expect(text).toContain("No usable environment policy at");
    expect(text).toContain(policyFile);
  });
});
