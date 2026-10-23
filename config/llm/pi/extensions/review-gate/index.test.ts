import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import reviewGateExtension, { dropStatusHeading, statusText } from "./index";
import { isolateGitConfig } from "./test-git-config";

const dirs: string[] = [];

let restoreGitConfig: (() => void) | undefined;

beforeAll(() => {
  restoreGitConfig = isolateGitConfig();
});

afterAll(() => {
  restoreGitConfig?.();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-status-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "example@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Example"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "chore: init"], { cwd: dir });
  return dir;
}

function writeLedger(
  path: string,
  entries: Array<{ repo: string; tree: string; message: string; reviewedAt: string }>,
): void {
  const map = Object.fromEntries(
    entries.map((entry) => [
      `${entry.repo}\u0000${entry.tree}`,
      { ...entry, verdict: { blocking: false, reasons: [], probabilities: {} } },
    ]),
  );
  writeFileSync(path, `${JSON.stringify({ version: 1, entries: map }, null, 2)}\n`);
}

/** Only the registration surface the tool_call handler needs. */
function fakePlugin(): (event: unknown) => Promise<unknown> {
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  const api = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (name: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(name, handler),
  } as unknown as ExtensionAPI;
  reviewGateExtension(api);
  const toolCall = handlers.get("tool_call");
  if (!toolCall) throw new Error("review-gate registered no tool_call handler");
  return toolCall;
}

describe("review-gate shell denials in the tool_call handler", () => {
  test("a shell command naming core.hooksPath is blocked, case-insensitively", async () => {
    const toolCall = fakePlugin();
    const denied = await toolCall({ toolName: "bash", input: { command: "git -c core.hookspath=/tmp/x commit" } });
    expect(denied).toMatchObject({ block: true });
    const allowed = await toolCall({ toolName: "bash", input: { command: "git status --short" } });
    expect(allowed).toBeUndefined();
  });
});

describe("review-gate status", () => {
  test("the status/picker helpers are pinned; the picker wiring is live-verified only", () => {
    expect(dropStatusHeading("review gate\n  hooks: not installed")).toBe("  hooks: not installed");
    expect(dropStatusHeading("other\nreview gate")).toBe("other\nreview gate");
    expect(dropStatusHeading("review gate")).toBe("");
  });

  test("statusText reads the injected state paths and spells out the counts", () => {
    const dir = repo();
    const root = realpathSync(dir);
    const state = mkdtempSync(join(tmpdir(), "review-gate-state-"));
    dirs.push(state);
    const paths = {
      ledgerPath: join(state, "review-ledger.json"),
      offPath: join(state, "review-gate-off"),
      exemptPath: join(state, "review-gate-exempt.json"),
    };
    const ctx = { cwd: dir } as ExtensionContext;
    const tree = "a".repeat(40);
    const newerTree = "b".repeat(40);
    const otherTree = "c".repeat(40);

    // Zero: an absent ledger, not the host's.
    expect(statusText(ctx, { ...paths, ledgerPath: join(state, "absent.json") })).toContain(
      "ledger: 0 entries across 0 repos",
    );

    // Three entries in two repos, one of them this temp repo's physical toplevel:
    // an entry count that differs from the distinct-repo count, and a
    // latest-review line no host ledger can produce.
    writeLedger(paths.ledgerPath, [
      { repo: root, tree, message: "feat(example): a thing", reviewedAt: "2026-10-23T12:00:00.000Z" },
      { repo: root, tree: newerTree, message: "feat(example): newer", reviewedAt: "2026-10-23T12:01:00.000Z" },
      { repo: "/tmp/other", tree: otherTree, message: "feat(other): other", reviewedAt: "2026-10-23T12:02:00.000Z" },
    ]);
    const status = statusText(ctx, paths);
    expect(status.split("\n")[0]).toBe("review gate");
    const picker = dropStatusHeading(status);
    expect(picker.split("\n")[0]).not.toBe("review gate");
    expect(picker).toContain("hooks:");
    expect(picker).toContain("repo:");
    expect(status).toContain("controls: enabled");
    expect(status).toContain("exempt: no");
    expect(status).toContain("ledger: 3 entries across 2 repos");
    expect(status).toContain(`latest review: ${newerTree.slice(0, 8)} clean`);
    writeFileSync(paths.offPath, "{}\n");
    expect(statusText(ctx, paths)).toContain("controls: disabled");

    // Singular counts are spelled out too.
    writeLedger(paths.ledgerPath, [
      { repo: "/tmp/example", tree, message: "feat(example): a thing", reviewedAt: "2026-10-23T12:00:00.000Z" },
    ]);
    expect(statusText(ctx, paths)).toContain("ledger: 1 entry across 1 repo");
  });
});
