import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandTilde,
  GATE_HOOKS_PATH,
  hasCommentLines,
  hooksInactiveReason,
  hooksPath,
  localHooksPath,
  normalizeMessage,
  repoToplevel,
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

  test("message normalization drops comment lines and edge blanks", () => {
    const dir = repoWithStagedFile();
    const message = "feat(x): subject\n\nbody line\n\n# a comment\n\n";
    expect(normalizeMessage(message, dir)).toBe("feat(x): subject\n\nbody line");
  });

  test("a message with a comment line is detected", () => {
    const dir = repoWithStagedFile();
    expect(hasCommentLines("feat(x): subject\n\n# a comment\n", dir)).toBe(true);
    expect(hasCommentLines("feat(x): subject\n\nbody\n\n", dir)).toBe(false);
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

  test("the gate's hook path is recognized as active", () => {
    const dir = repoWithStagedFile();
    execFileSync("git", ["config", "--local", "core.hooksPath", GATE_HOOKS_PATH], { cwd: dir });
    expect(hooksInactiveReason(dir)).toBeNull();
  });
});
