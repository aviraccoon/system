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
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionsAnswer } from "../shared/decisions";
import type { PolicyAsk } from "../shared/env-policy";
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

interface Guard {
  fire(event: string, payload?: unknown): Promise<unknown>;
  command(name: string, args: string): Promise<void>;
  /** Notifications the extension sent through `ctx.ui.notify`. */
  notices: string[];
}

/** A loaded extension instance whose `pi` records every handler, so a test can drive any event. */
async function started(cwd: string): Promise<Guard> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, definition);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
    modelRegistry: {},
    signal: undefined,
  } as unknown as ExtensionContext;
  const notices: string[] = [];

  envGuardExtension(pi, { ask: ASK, policyPath: () => policyFile });
  await handlers.get("session_start")?.({}, ctx);
  return {
    fire: async (event, payload) => handlers.get(event)?.(payload ?? {}, ctx),
    command: async (name, args) => {
      const definition = commands.get(name);
      if (!definition) throw new Error(`no command ${name}`);
      await definition.handler(args, ctx);
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
