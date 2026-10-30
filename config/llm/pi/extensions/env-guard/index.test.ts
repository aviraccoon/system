/**
 * Wiring test for the guard's tool-call floor: what the agent actually receives.
 *
 * The policy path and the decision model are injected (`EnvGuardOverrides`), so
 * this runs without a pi session, a network call or the notes tree. It exists
 * because dropping the `ctx.cwd` argument to `refusalText` restores a nested `cd`
 * in the replacement, and no other test fails.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  policyFile = join(dir, "environment.json");
  writeFileSync(policyFile, JSON.stringify(POLICY));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run one bash tool call through the extension and return the block reason. */
async function blockReason(command: string, cwd: string): Promise<string | undefined> {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    ui: { notify: () => {} },
    modelRegistry: {},
    signal: undefined,
  } as unknown as ExtensionContext;
  const ask: PolicyAsk = async (questions) => {
    const answers: Record<string, DecisionsAnswer> = {};
    if ("policy_violation" in questions) answers.policy_violation = { type: "noul", noul: 0.95 };
    else answers.policy_clause = { type: "choice", choice: "deps", probabilities: { deps: 0.9 } };
    return answers;
  };

  envGuardExtension(pi, { ask, policyPath: () => policyFile });
  await handlers.get("session_start")?.({}, ctx);
  const result = (await handlers.get("tool_call")?.({ toolName: "bash", input: { command } }, ctx)) as
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
});
