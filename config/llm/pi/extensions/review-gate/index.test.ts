import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/** Only the registration surface these tests need: the tool_call handler and the command. */
function fakePlugin(options: { decisionLogPath?: string } = {}): {
  toolCall: (event: unknown) => Promise<unknown>;
  command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
} {
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const api = {
    registerTool: () => {},
    on: (name: string, handler: (event: unknown) => Promise<unknown>) => handlers.set(name, handler),
    registerCommand: (name: string, value: unknown) => commands.set(name, value as never),
  } as unknown as ExtensionAPI;
  reviewGateExtension(api, options);
  const toolCall = handlers.get("tool_call");
  if (!toolCall) throw new Error("review-gate registered no tool_call handler");
  const command = commands.get("review-gate");
  if (!command) throw new Error("review-gate registered no command");
  return { toolCall, command };
}

describe("/review-gate log", () => {
  test("shows the last decisions from the log it reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-log-"));
    dirs.push(dir);
    const logPath = join(dir, "review-gate.log");
    writeFileSync(
      logPath,
      [
        "2026-01-01T00:00:00Z\tpassed\t/acme/repo\t1111111111\treviewed",
        "2026-01-01T00:00:01Z\trefused\t/acme/repo\t2222222222\tno-review",
      ].join("\n"),
    );
    const { command } = fakePlugin({ decisionLogPath: logPath });
    const shown: string[] = [];
    const ctx = {
      hasUI: true,
      cwd: dir,
      ui: {
        select: async (text: string) => {
          shown.push(text);
        },
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    await command.handler("log 1", ctx);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("refused");
    expect(shown[0]).not.toContain("passed");
  });

  test("a log that does not exist yet is empty, not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-log-"));
    dirs.push(dir);
    const { command } = fakePlugin({ decisionLogPath: join(dir, "review-gate.log") });
    const shown: string[] = [];
    const ctx = {
      hasUI: true,
      cwd: dir,
      ui: {
        select: async (text: string) => {
          shown.push(text);
        },
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    await command.handler("log", ctx);
    expect(shown[0]).toContain("No commit decisions recorded");
    expect(shown[0]).not.toContain("Cannot read");
  });

  test("a log that cannot be read is an error, not an empty log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-log-"));
    dirs.push(dir);
    // A directory where the log should be: readable path, unreadable file.
    const logPath = join(dir, "review-gate.log");
    mkdirSync(logPath);
    const { command } = fakePlugin({ decisionLogPath: logPath });
    const shown: string[] = [];
    const ctx = {
      hasUI: true,
      cwd: dir,
      ui: {
        select: async (text: string) => {
          shown.push(text);
        },
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    await command.handler("log", ctx);
    expect(shown[0]).toContain("Cannot read");
    expect(shown[0]).not.toContain("No commit decisions recorded");
  });
});

describe("review-gate shell denials in the tool_call handler", () => {
  test("a shell command naming core.hooksPath is blocked, case-insensitively", async () => {
    const { toolCall } = fakePlugin();
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
