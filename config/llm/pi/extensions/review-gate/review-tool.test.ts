import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { ReviewLedgerEntry } from "../shared/review-ledger";
import { type GateOutcome, gateFromAnswers } from "./gate";
import { gateNoteColor } from "./render";
import {
  type DispatchResult,
  nothingStagedRefusal,
  PATHS_ROUND_NOTE,
  type ReviewDeps,
  runReview,
  taskWithMessage,
  taskWithPathsScope,
} from "./review-tool";
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
  const dir = mkdtempSync(join(tmpdir(), "review-tool-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "example@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Example"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "chore: init"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "b\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  return dir;
}

/** A repository whose index and working tree both match HEAD. */
function committedRepo(): string {
  const dir = repo();
  execFileSync("git", ["commit", "-qm", "chore: change"], { cwd: dir });
  return dir;
}

/** A repository with a staged first commit and no HEAD yet. */
function unbornRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-tool-unborn-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "example@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Example"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  return dir;
}

function conflictedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-tool-conflict-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "example@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Example"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "base\n");
  execFileSync("git", ["add", "a.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "chore: init"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "-b", "side"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "side\n");
  execFileSync("git", ["commit", "-qam", "feat: side"], { cwd: dir });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "main\n");
  execFileSync("git", ["commit", "-qam", "feat: main"], { cwd: dir });
  try {
    execFileSync("git", ["merge", "side"], { cwd: dir, stdio: "ignore" });
  } catch {
    // the merge conflict is the fixture
  }
  return dir;
}

function ctxAt(cwd: string): ExtensionToolContext {
  return { cwd } as ExtensionToolContext;
}

const MESSAGE = "feat(example): change a";

function outcome(probabilities: Partial<Record<"severity" | "behavior" | "unfinished" | "message", number>> = {}) {
  const values = { severity: 0.02, behavior: 0.02, unfinished: 0.01, message: 0.02, ...probabilities };
  return gateFromAnswers(
    Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { type: "noul" as const, noul: value }])),
  ) as GateOutcome;
}

function report(text = "No findings. The message matches the diff."): DispatchResult {
  return {
    content: [{ type: "text", text }],
    isError: false,
    details: { mode: "single", results: [{ agent: "reviewer", exitCode: 0 }] },
  };
}

interface Recorded {
  entries: ReviewLedgerEntry[];
}

function deps(overrides: Partial<ReviewDeps> = {}): ReviewDeps & Recorded {
  const entries: ReviewLedgerEntry[] = [];
  return {
    entries,
    dispatch: async () => report(),
    classify: async () => outcome(),
    record: (entry) => {
      entries.push(entry);
    },
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    sessionId: "session-1",
    ...overrides,
  };
}

function text(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("nothing staged", () => {
  test("the refusal fires only when the index is HEAD's tree and the working tree is dirty", () => {
    const head = "a".repeat(40);
    expect(nothingStagedRefusal(head, head, true)).toContain("nothing is staged");
    expect(nothingStagedRefusal(head, head, true)).toContain("unreviewed delta");
    expect(nothingStagedRefusal(head, head, false)).toBeNull();
    expect(nothingStagedRefusal(head, "b".repeat(40), true)).toBeNull();
    // A first commit has no HEAD tree to be identical to.
    expect(nothingStagedRefusal(head, null, true)).toBeNull();
  });

  test("an unstaged change is refused before the reviewer runs", async () => {
    const dir = repo();
    execFileSync("git", ["restore", "--staged", "a.txt"], { cwd: dir });
    let ran = false;
    const d = deps({
      dispatch: async () => {
        ran = true;
        return report();
      },
    });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(ran).toBe(false);
    expect(d.entries).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("nothing is staged");
    expect(text(result)).toContain("Stage it, then call the `review` tool again");
    // A working-tree round that records nothing is a real case: the parallel review.
    expect(text(result)).toContain('pass scope "paths" instead');
  });

  test("a staged change reviews even when the working tree holds more", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.txt"), "c\n");
    const d = deps();
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(1);
    expect(text(result)).toContain("gate: clean for tree");
  });

  test("an untracked file does not make a clean tree look unstaged", async () => {
    const dir = committedRepo();
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    const d = deps();
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(1);
    expect(text(result)).toContain("gate: clean for tree");
  });

  test("an index at HEAD with a clean working tree still reviews", async () => {
    const dir = committedRepo();
    const d = deps();
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(1);
    expect(text(result)).toContain("gate: clean for tree");
  });

  test("a first commit with an unborn HEAD reviews", async () => {
    const dir = unbornRepo();
    const d = deps();
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(1);
    expect(text(result)).toContain("gate: clean for tree");
  });
});

describe("paths scope", () => {
  test("a paths round reviews the unstaged working tree and records nothing", async () => {
    const dir = repo();
    execFileSync("git", ["restore", "--staged", "a.txt"], { cwd: dir });
    let dispatchedTask = "";
    let classified = false;
    const dispatched = report();
    const d = deps({
      dispatch: async (args) => {
        dispatchedTask = args.task;
        return dispatched;
      },
      classify: async () => {
        classified = true;
        return outcome();
      },
    });
    const result = await runReview({ task: "review src/a.ts", scope: "paths" }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(classified).toBe(false);
    expect(dispatchedTask).toBe(taskWithPathsScope("review src/a.ts"));
    // Each fragment keeps the reviewer prompt's pre-commit rules from firing: the
    // round's scope, its target, that it records nothing, the two states it
    // expects, and where the message is judged instead.
    for (const fragment of [
      "This is a path-scoped round",
      "review the paths the task names against the working tree",
      "new files with `git status --short --untracked-files=all -- <paths>`",
      "records no verdict, so the index is not its target",
      "expected here, not findings",
      "judged in the staged round that follows",
    ]) {
      expect(dispatchedTask).toContain(fragment);
    }
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain("gate: nothing recorded");
    expect(text(result)).toContain('scope "staged"');
    expect(result.details).toBe(dispatched.details);
  });

  test("the paths note is what a commit cannot use", () => {
    expect(PATHS_ROUND_NOTE).toContain("records no verdict for a commit");
    expect(PATHS_ROUND_NOTE).toContain('call `review` with scope "staged"');
    expect(PATHS_ROUND_NOTE).toContain("before it is committed");
  });

  test("a paths round outside a repository still runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-tool-paths-plain-"));
    dirs.push(dir);
    const d = deps();
    const result = await runReview({ task: "review notes.md", scope: "paths" }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("gate: nothing recorded");
  });

  test("a paths round refuses a proposed message before the reviewer runs", async () => {
    const dir = repo();
    let ran = false;
    const d = deps({
      dispatch: async () => {
        ran = true;
        return report();
      },
    });
    const result = await runReview({ task: "review", scope: "paths", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(ran).toBe(false);
    expect(d.entries).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("a paths round records nothing, so it takes no proposedMessage");
  });

  test("a staged round refuses to run without a message", async () => {
    const dir = repo();
    let ran = false;
    const d = deps({
      dispatch: async () => {
        ran = true;
        return report();
      },
    });
    const result = await runReview({ task: "review", scope: "staged" }, ctxAt(dir), d);
    expect(ran).toBe(false);
    expect(d.entries).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("proposedMessage is required for a staged round");
  });
});

describe("review tool", () => {
  test("a clean round records the tree, the normalized message and the verdict", async () => {
    const dir = repo();
    const dispatched = report();
    const d = deps({ dispatch: async () => dispatched });
    const result = await runReview({ task: "review the change", proposedMessage: `${MESSAGE}\n\n` }, ctxAt(dir), d);
    const recorded = d.entries[0];
    expect(recorded?.repo).toBe(realpathSync(dir));
    expect(recorded?.tree).toHaveLength(40);
    expect(recorded?.message).toBe(MESSAGE);
    expect(recorded?.verdict.blocking).toBe(false);
    expect(recorded?.sessionId).toBe("session-1");
    // The renderer needs the report and the note as separate blocks, and the
    // child's details for the turn view.
    expect(result.content).toHaveLength(2);
    expect((result.content[1] as { text: string }).text.startsWith("gate: ")).toBe(true);
    expect(result.details).toBe(dispatched.details);
    expect(text(result)).toContain("gate: clean for tree");
  });

  test("a blocking verdict is recorded and named in the note", async () => {
    const dir = repo();
    const d = deps({ classify: async () => outcome({ severity: 0.97 }) });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries[0]?.verdict.blocking).toBe(true);
    expect(text(result)).toContain("severity 0.97 ≥ 0.85");
  });

  test("the message and the requirement are injected into the child task, normalized", async () => {
    const dir = repo();
    let dispatched = "";
    const d = deps({
      dispatch: async (args) => {
        dispatched = args.task;
        return report();
      },
    });
    await runReview({ task: "review the change", proposedMessage: `${MESSAGE}\n\n   \n` }, ctxAt(dir), d);
    expect(dispatched).toBe(taskWithMessage("review the change", MESSAGE));
    expect(dispatched).toContain(MESSAGE);
    // Each fragment guards one clause the requirement cannot lose: the imperative, the consequence of
    // skipping it, its override of whatever the task says, the shortcut's precondition, its default,
    // and the judgment it must name.
    for (const fragment of [
      "Judge the message against the diff in this round's report",
      "a round that does not address it blocks the commit",
      "whatever the task above says about it",
      "If the task says an earlier round judged this message and it is unchanged",
      "otherwise judge it here",
      "saying that the message judgment holds against this diff is enough",
    ]) {
      expect(dispatched).toContain(fragment);
    }
  });

  test("an empty message fails before the reviewer runs", async () => {
    const dir = repo();
    let ran = false;
    const d = deps({
      dispatch: async () => {
        ran = true;
        return report();
      },
    });
    const result = await runReview({ task: "review", proposedMessage: " \n \n" }, ctxAt(dir), d);
    expect(ran).toBe(false);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("proposedMessage is empty");
  });

  test("a failed dispatch records nothing", async () => {
    const dir = repo();
    const d = deps({ dispatch: async () => ({ content: [], isError: true, details: undefined }) });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("nothing recorded");
  });

  test("a subagent refusal without an error flag records nothing", async () => {
    const dir = repo();
    const d = deps({
      dispatch: async () => ({
        content: [{ type: "text", text: "Subagent tool is disabled. Use /subagent-toggle to re-enable." }],
        isError: false,
        details: { mode: "single", results: [] },
      }),
    });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("did not complete a review run");
  });

  test("a nonzero exit or a max-turns stop records nothing", async () => {
    const dir = repo();
    for (const result of [
      { agent: "reviewer", exitCode: 1 },
      { agent: "reviewer", exitCode: 0, stopReason: "max_turns_exceeded" },
      { agent: "researcher", exitCode: 0 },
    ]) {
      const d = deps({
        dispatch: async () => ({
          content: [{ type: "text", text: "a report that must not count" }],
          isError: false,
          details: { mode: "single", results: [result] },
        }),
      });
      const outcome = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
      expect(d.entries).toHaveLength(0);
      expect(text(outcome)).toContain("did not complete a review run");
    }
  });

  test("an empty report records nothing", async () => {
    const dir = repo();
    const d = deps({ dispatch: async () => report("  \n") });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("no report");
  });

  test("a classifier failure records nothing and reads as blocked", async () => {
    const dir = repo();
    const d = deps({ classify: async () => null });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("blocked");
    expect(text(result)).toContain("fail-closed");
  });

  test("a thrown classifier error keeps its cause in the note", async () => {
    const dir = repo();
    const d = deps({
      classify: async () => {
        throw new Error('no credential for "openrouter"');
      },
    });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain('no credential for "openrouter"');
    expect(text(result)).toContain("nothing recorded");
  });

  test("a tree changed during the round invalidates it", async () => {
    const dir = repo();
    const d = deps({
      dispatch: async () => {
        writeFileSync(join(dir, "a.txt"), "c\n");
        execFileSync("git", ["add", "a.txt"], { cwd: dir });
        return report();
      },
    });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("changed during the review");
  });

  test("outside a repository the review runs and nothing is recorded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-tool-plain-"));
    dirs.push(dir);
    const d = deps();
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("not a git repository");
  });

  test("a clean round says so when the gate's hooks cannot run here", async () => {
    const dir = repo();
    execFileSync("git", ["config", "--local", "core.hooksPath", ".husky/_"], { cwd: dir });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), deps());
    expect(text(result)).toContain("gate: clean for tree");
    expect(text(result)).toContain(
      "the gate's hooks are not active for this repo (this repo sets core.hooksPath=.husky/_)",
    );
    // The renderer's color is the only state cue in the collapsed result slot.
    expect(gateNoteColor((result.content[1] as { text: string }).text)).toBe("warning");
  });

  test("a re-read failure records nothing and keeps the report head", async () => {
    const dir = repo();
    const d = deps({
      dispatch: async () => {
        rmSync(join(dir, ".git"), { recursive: true, force: true });
        return report();
      },
    });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(d.entries).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
    expect((result.content[0] as { text: string }).text).toContain("No findings");
    expect((result.content[1] as { text: string }).text.startsWith("gate: cannot re-read")).toBe(true);
  });

  test("an unmerged index fails before the reviewer runs", async () => {
    const dir = conflictedRepo();
    let ran = false;
    const d = deps({
      dispatch: async () => {
        ran = true;
        return report();
      },
    });
    const result = await runReview({ task: "review", proposedMessage: MESSAGE }, ctxAt(dir), d);
    expect(ran).toBe(false);
    expect(d.entries).toHaveLength(0);
    expect(text(result)).toContain("cannot read the index tree or HEAD's tree");
  });
});
