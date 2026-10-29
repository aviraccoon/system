import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandTilde,
  GATE_HOOKS_PATH,
  headTree,
  hooksInactiveReason,
  hooksPath,
  localHooksPath,
  normalizeMessage,
  repoHooks,
  repoToplevel,
  worktreeDirty,
  writeTree,
} from "./git";
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

function repoWithStagedFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-git-"));
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

describe("git plumbing", () => {
  test("the staged tree is the one a commit records", () => {
    const dir = repoWithStagedFile();
    const tree = writeTree(dir);
    execFileSync("git", ["commit", "-qm", "feat: change"], { cwd: dir });
    const committed = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf-8" }).trim();
    expect(tree).toBe(committed);
  });

  test("HEAD's tree is the committed tree, and null before the first commit", () => {
    const dir = repoWithStagedFile();
    const staged = writeTree(dir);
    execFileSync("git", ["commit", "-qm", "feat: change"], { cwd: dir });
    expect(headTree(dir)).toBe(staged);
    const unborn = mkdtempSync(join(tmpdir(), "review-git-unborn-"));
    dirs.push(unborn);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: unborn });
    expect(headTree(unborn)).toBeNull();
  });

  test("a HEAD whose tree cannot be read throws instead of reading as a first commit", () => {
    const dir = repoWithStagedFile();
    execFileSync("git", ["commit", "-qm", "feat: change"], { cwd: dir });
    const tree = headTree(dir) as string;
    rmSync(join(dir, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
    expect(() => headTree(dir)).toThrow();
  });

  test("the working tree is dirty for tracked changes, untracked files excluded", () => {
    const dir = repoWithStagedFile();
    execFileSync("git", ["commit", "-qm", "chore: init"], { cwd: dir });
    expect(worktreeDirty(dir)).toBe(false);
    // An untracked file never enters a commit, so it does not count.
    writeFileSync(join(dir, "untracked.txt"), "x\n");
    expect(worktreeDirty(dir)).toBe(false);
    // Intent-to-add is the index saying a path is about to be committed.
    execFileSync("git", ["add", "-N", "untracked.txt"], { cwd: dir });
    expect(worktreeDirty(dir)).toBe(true);
    writeFileSync(join(dir, "a.txt"), "c\n");
    expect(worktreeDirty(dir)).toBe(true);
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    expect(worktreeDirty(dir)).toBe(true);
  });

  test("a directory outside a repository has no toplevel", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-git-plain-"));
    dirs.push(dir);
    expect(repoToplevel(dir)).toBeNull();
  });

  test("the toplevel is the repository root, from a nested directory too", () => {
    const dir = repoWithStagedFile();
    const nested = join(dir, "nested");
    mkdirSync(nested);
    const root = realpathSync(dir);
    expect(repoToplevel(dir)).toBe(root);
    expect(repoToplevel(nested)).toBe(root);
  });

  test("message normalization drops edge blanks and keeps a comment line", () => {
    const dir = repoWithStagedFile();
    const message = "feat(x): subject\n\nbody line\n\n# a comment\n\n";
    expect(normalizeMessage(message, dir)).toBe("feat(x): subject\n\nbody line\n\n# a comment");
  });

  test("a subject-only message is unchanged", () => {
    const dir = repoWithStagedFile();
    expect(normalizeMessage("chore: pin\n\n", dir)).toBe("chore: pin");
  });

  test("hooks paths are read from the repository config", () => {
    const dir = repoWithStagedFile();
    expect(localHooksPath(dir)).toBeNull();
    expect(hooksPath(dir)).toBeNull();
    expect(hooksInactiveReason(dir)).toBe("core.hooksPath is unset");
    execFileSync("git", ["config", "--local", "core.hooksPath", ".husky/_"], { cwd: dir });
    expect(localHooksPath(dir)).toBe(".husky/_");
    expect(hooksPath(dir)).toBe(".husky/_");
    expect(hooksInactiveReason(dir)).toBe("this repo sets core.hooksPath=.husky/_");
  });

  test("a tilde hooks path expands to the home directory", () => {
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/.config/git/hooks")).toBe(join(homedir(), ".config/git/hooks"));
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
    expect(expandTilde("relative/path")).toBe("relative/path");
  });

  test("repository hooks are listed with their content hash, samples excluded", () => {
    const dir = repoWithStagedFile();
    const hooksDir = join(dir, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    writeFileSync(join(hooksDir, "pre-commit.sample"), "#!/bin/sh\necho sample\n", { mode: 0o755 });
    writeFileSync(join(hooksDir, "notes.txt"), "not a hook\n", { mode: 0o644 });
    const hooks = repoHooks(dir);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.name).toBe("pre-commit");
    expect(hooks[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(hooks[0]?.sha256).not.toBe("");
  });

  test("the gate's hook path is recognized as active", () => {
    const dir = repoWithStagedFile();
    execFileSync("git", ["config", "--local", "core.hooksPath", GATE_HOOKS_PATH], { cwd: dir });
    expect(hooksInactiveReason(dir)).toBeNull();
  });
});
