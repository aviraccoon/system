/**
 * Wiring test for the guard: what the agent receives at the start of a turn, and
 * what the floor refuses. The policy path and the decision model are injected
 * (`PolicyGuardOverrides`), so this runs without a pi session, a network call or the
 * notes tree.
 *
 * It exists because the wiring is where the silent failures live: a call summary built
 * without `ctx.cwd` resolves every path against the process directory, a policy the agent
 * can edit is a policy that is not enforced at all, and a tool branch that returns early
 * leaves every non-bash clause unread.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { DecisionsAnswer } from "../shared/decisions";
import type { PolicyAsk } from "../shared/policy";
import { FILE_LIMIT, parseDecisions } from "./decisions";
import policyGuardExtension, { DECISIONS_PATH } from "./index";

const POLICY = {
  project: "acme-widgets",
  binding: {
    command: "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    workdir: "/workspaces/acme-widgets/app",
  },
  clauses: [{ id: "deps", text: "Dependency work runs in the devcontainer." }],
};

let dir = "";
let policyFile = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-guard-"));
  policyFile = join(dir, ".agents", "policy.json");
  mkdirSync(dirname(policyFile), { recursive: true });
  writeFileSync(policyFile, JSON.stringify(POLICY));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The judge's answers, injected so no test needs a network call. */
const ASK: PolicyAsk = async (questions) => {
  const answers: Record<string, DecisionsAnswer> = {};
  for (const key of Object.keys(questions)) answers[key] = { type: "noul", noul: 0.95 };
  return answers;
};

/** A judge that clears everything: for the allowed side of the record. */
const CLEARS: PolicyAsk = async (questions) => {
  const answers: Record<string, DecisionsAnswer> = {};
  for (const key of Object.keys(questions)) answers[key] = { type: "noul", noul: 0.05 };
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
  decisionsPath: string = join(dir, "policy-guard.log"),
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

  policyGuardExtension(pi, { ask, policyPath: () => policyFile, decisionsPath });
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
  test("the refusal names the clause that fired and quotes it", async () => {
    const reason = await blockReason("pnpm install --frozen-lockfile", "/Users/acme/acme-widgets");
    expect(reason).toContain("[policy-guard] refused by clause deps: Dependency work runs in the devcontainer.");
  });

  test("the refusal carries nothing about the call, since a clause can be about any axis", async () => {
    const reason = await blockReason("pnpm install --frozen-lockfile", "/Users/acme/acme-widgets");
    expect(reason).not.toContain("sh -lc");
    expect(reason).not.toContain("instead");
  });

  test("the refusal names the file the rules live in, so a wrong clause is reportable", async () => {
    const reason = await blockReason("pnpm install", "/Users/acme/acme-widgets");
    expect(reason).toContain(`Rules: ${policyFile}`);
    expect(reason).toContain("the user's to change");
  });
});

describe("every tool call", () => {
  test("a write that breaks a clause is refused, and the record names the path it targeted", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: join(dir, "src", "a.ts"), content: "x" },
    })) as { block?: boolean; reason?: string } | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("refused by clause deps");
    const records = parseDecisions(readFileSync(join(dir, "policy-guard.log"), "utf-8"));
    expect(records[0]?.command.endsWith("a.ts")).toBe(true);
  });

  test("a call that names nothing a clause could be about is not judged", async () => {
    let calls = 0;
    const counting: PolicyAsk = async (questions) => {
      calls++;
      return ASK(questions, {});
    };
    const guard = await started(dir, "s-test", counting);
    const result = await guard.fire("tool_call", { toolName: "policy", input: {} });
    expect(result).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("the bash tool's own budget reaches the judge, so a budgeted call is not read as unbudgeted", async () => {
    const seen: Record<string, unknown>[] = [];
    const recording: PolicyAsk = async (questions, state) => {
      seen.push(state);
      return CLEARS(questions, state);
    };
    const guard = await started(dir, "s-test", recording);
    await guard.fire("tool_call", { toolName: "bash", input: { command: "pnpm test", timeout: 240 } });
    expect(seen[0]?.timeout).toBe(240);
  });

  test("a non-shell refusal names the unlock that works for it", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: join(dir, "a.ts") },
    })) as { block?: boolean; reason?: string } | undefined;
    expect(result?.reason).toContain("/guard off");
    expect(result?.reason).toContain("covers host work only");
  });

  test("a clause the judge did not answer is reported, and the rest still decide", async () => {
    writeFileSync(
      policyFile,
      JSON.stringify({
        ...POLICY,
        clauses: [...POLICY.clauses, { id: "e2e", text: "Browser suites run on the host." }],
      }),
    );
    const partial: PolicyAsk = async (questions) => {
      const out: Record<string, DecisionsAnswer> = {};
      for (const key of Object.keys(questions)) if (key === "clause:deps") out[key] = { type: "noul", noul: 0.95 };
      return out;
    };
    const guard = await started(dir, "s-test", partial);
    const result = (await guard.fire("tool_call", { toolName: "bash", input: { command: "pnpm install" } })) as
      | { block?: boolean; reason?: string }
      | undefined;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("clause deps");
    expect(guard.notices.join("\n")).toContain("did not answer for e2e");
  });

  test("the decision log records what a search asked for, not the tool name", async () => {
    const guard = await started(dir, "s-test", CLEARS);
    await guard.fire("tool_call", { toolName: "web_search", input: { query: "acme widgets" } });
    const records = parseDecisions(readFileSync(join(dir, "policy-guard.log"), "utf-8"));
    expect(records[0]?.command).toBe("acme widgets");
  });

  test("a session grant covers host work, not a write", async () => {
    const guard = await started(dir);
    await guard.command("guard", "allow");
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: join(dir, "a.ts") },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
  });

  test("the same call twice is judged once, so a retry does not pay for a second request", async () => {
    let calls = 0;
    const counting: PolicyAsk = async (questions) => {
      calls++;
      return ASK(questions, {});
    };
    const guard = await started(dir, "s-test", counting);
    const call = { toolName: "bash", input: { command: "pnpm install" } };
    await guard.fire("tool_call", call);
    await guard.fire("tool_call", call);
    expect(calls).toBe(1);
  });
});

describe("rules in context", () => {
  test("the first turn carries the policy, rendered from the file the judge reads", async () => {
    const guard = await started("/Users/acme/acme-widgets");
    const result = (await guard.fire("before_agent_start")) as
      | { message?: { content?: string; display?: boolean } }
      | undefined;
    expect(result?.message?.content).toContain("enforced by pi's policy-guard");
    expect(result?.message?.content).toContain("- deps: Dependency work runs in the devcontainer.");
    expect(result?.message?.content).toContain(policyFile);
    expect(result?.message?.display).toBe(false);
  });

  test("the injected entry carries this extension's customType", async () => {
    const guard = await started("/Users/acme/acme-widgets");
    const result = (await guard.fire("before_agent_start")) as { message?: { customType?: string } } | undefined;
    expect(result?.message?.customType).toBe("policy-guard-policy");
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
      input: { path: join(".agents", "policy.json") },
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
    const mangled = policyFile.replace("policy.json", "Policy.JSON");
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
      input: { path: join(".agents", "Policy.json") },
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
      input: { path: join(".agents", "Policy.json") },
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

  test("/guard status names the clauses running on the default criteria", async () => {
    const guard = await started(dir);
    await guard.command("guard", "status");
    // The fixture's clause has no criteria, so the author is told it runs on the neutral pair.
    expect(guard.notices.join("\n")).toContain("clauses on the default criteria: deps");
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

  test("a ~ path is expanded before the floor sees it", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: "~/.agents/policy.json" },
    })) as { block?: boolean } | undefined;
    expect(result?.block).toBe(true);
    // The name check alone also passes on `<cwd>/~/...`; the recorded target is the expanded path.
    const records = parseDecisions(readFileSync(join(dir, "policy-guard.log"), "utf-8"));
    expect(records[0]?.command).toBe(join(homedir(), ".agents", "policy.json"));
  });

  test("a leading @ is resolved the way the write tools resolve it", async () => {
    const guard = await started(dir);
    const result = (await guard.fire("tool_call", {
      toolName: "write",
      input: { path: "@.agents/policy.json" },
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
    // Every tool call is judged now, so the judge clears this one: the floor is what must not fire.
    const guard = await started(dir, "s-test", CLEARS);
    const result = await guard.fire("tool_call", {
      toolName: "patch",
      input: { path: join(dir, "README.md"), edits: [{ oldText: "a", newText: "b" }] },
    });
    expect(result).toBeUndefined();
  });

  test("the read tool is the way in, so reading the policy passes", async () => {
    // The shell refusal tells the agent to read the file; if the floor also refused the read tool,
    // that advice would be a dead end.
    const guard = await started(dir, "s-test", CLEARS);
    const result = await guard.fire("tool_call", { toolName: "read", input: { path: policyFile } });
    expect(result).toBeUndefined();
  });
});

describe("policy tool", () => {
  test("reports the rules, the session state and what was judged, without the probability", async () => {
    const guard = await started(dir);
    await guard.fire("tool_call", { toolName: "bash", input: { command: "pnpm install" } });
    const text = await guard.tool("policy");
    expect(text).toContain("enforced by pi's policy-guard");
    expect(text).toContain("state: on; host grant: not given");
    expect(text).toContain("judged in this session (newest 1):");
    expect(text).toContain("refused  pnpm install -> deps");
    // The judge answered 0.95; that number belongs to the file, not to the agent.
    expect(text).not.toContain("0.95");
  });

  test("the log keeps the probability and records a cleared call, which the view hides", async () => {
    const guard = await started(dir, "s-log", CLEARS);
    await guard.fire("tool_call", { toolName: "bash", input: { command: "git status" } });
    const records = parseDecisions(readFileSync(join(dir, "policy-guard.log"), "utf-8"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ violated: false, probability: 0.05, threshold: 0.65, session: "s-log" });
    const text = await guard.tool("policy");
    expect(text).toContain("- allowed  git status");
    expect(text).not.toContain("0.05");
  });

  test("an unwritable log does not stop the refusal", async () => {
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "a file where the log's directory would be");
    const guard = await started(dir, "s-test", ASK, join(blocked, "policy-guard.log"));
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
    const text = await second.tool("policy");
    expect(text).toContain("judged in this session: none yet");
    expect(text).not.toContain("pnpm install");
  });

  test("trims the log at session start, and leaves a short one alone", async () => {
    const line = (index: number) =>
      `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", session: "old", project: "acme", kind: "policy", command: `cmd-${index}`, violated: true, clause: "deps", probability: 0.9, threshold: 0.65 })}\n`;
    writeFileSync(
      join(dir, "policy-guard.log"),
      Array.from({ length: FILE_LIMIT + 1 }, (_, index) => line(index)).join(""),
    );
    await started(dir);
    const kept = parseDecisions(readFileSync(join(dir, "policy-guard.log"), "utf-8"));
    expect(kept).toHaveLength(FILE_LIMIT);
    expect(kept.at(-1)?.command).toBe(`cmd-${FILE_LIMIT}`);
    // A file under the limit is left byte-identical.
    const short = line(1) + line(2);
    writeFileSync(join(dir, "policy-guard.log"), short);
    await started(dir);
    expect(readFileSync(join(dir, "policy-guard.log"), "utf-8")).toBe(short);
  });

  test("another window's records cannot push this session's out of the view", async () => {
    const line = (session: string, command: string) =>
      `${JSON.stringify({ at: "2026-01-01T00:00:00.000Z", session, project: "acme", kind: "policy", command, violated: true, clause: "deps", probability: 0.9, threshold: 0.65 })}\n`;
    // This session's record first, then enough of another window's to fill any tail window.
    const mine = line("s-mine", "pnpm install");
    const others = Array.from({ length: 600 }, (_, index) => line("other", `other-${index}`)).join("");
    writeFileSync(join(dir, "policy-guard.log"), mine + others);
    const guard = await started(dir, "s-mine");
    expect(await guard.tool("policy")).toContain("refused  pnpm install -> deps");
  });

  test("reports a session grant", async () => {
    const guard = await started(dir);
    await guard.command("guard", "allow");
    expect(await guard.tool("policy")).toContain("host grant: given for this session");
  });

  test("records a policy-file write under its own reason, with the path it targeted", async () => {
    const guard = await started(dir);
    await guard.fire("tool_call", { toolName: "write", input: { path: policyFile } });
    expect(await guard.tool("policy")).toContain("refused (policy file write)");
    // The floor refusal carries no clause, and the view must say so rather than render null.
    expect(await guard.tool("policy")).toContain("-> no clause cited");
    // The record names the target, not the tool: a clipped path still starts with the path.
    const records = parseDecisions(readFileSync(join(dir, "policy-guard.log"), "utf-8"));
    expect(records[0]?.command.startsWith(policyFile.slice(0, 60))).toBe(true);
  });

  test("records a shell command naming the policy under its own reason", async () => {
    const guard = await started(dir);
    await guard.fire("tool_call", { toolName: "bash", input: { command: `cat ${policyFile}` } });
    const text = await guard.tool("policy");
    expect(text).toContain("refused (policy file named in shell)");
  });

  test("reports the guard as off when it is", async () => {
    const guard = await started(dir);
    await guard.command("guard", "off");
    expect(await guard.tool("policy")).toContain("state: off");
  });

  test("reports a policy's parse errors instead of its rules", async () => {
    writeFileSync(policyFile, '{"project":""}');
    const guard = await started(dir);
    const text = await guard.tool("policy");
    expect(text).toContain("No usable policy at");
    expect(text).toContain("errors:");
  });

  test("says so when no policy loaded, rather than rendering an empty block", async () => {
    rmSync(policyFile, { force: true });
    const guard = await started(dir);
    const text = await guard.tool("policy");
    expect(text).toContain("No usable policy at");
    expect(text).toContain(policyFile);
  });
});

// The default log path is used only in production; every test injects one, so this pin is its only check.
describe("default log path", () => {
  test("the default decision log is the state directory's policy-guard.log", () => {
    expect(DECISIONS_PATH).toBe(join(homedir(), ".pi", "agent", "state", "policy-guard.log"));
  });
});
