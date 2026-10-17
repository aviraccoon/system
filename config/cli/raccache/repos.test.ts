import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRepoIgnores, discoverRepos, readRepoIgnores } from "./repos";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "raccache-repos-"));
  const acme = join(root, "projects/acme");
  mkdirSync(join(acme, "junk"), { recursive: true });
  writeFileSync(join(acme, ".gitignore"), "junk/\nlocal.env\n");
  writeFileSync(join(acme, "keep.txt"), "keep\n");
  writeFileSync(join(acme, "junk/artifact.bin"), "junk\n");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", acme]);
  // a generated checkout under a pruned directory: never scanned
  mkdirSync(join(acme, "node_modules/dep/.git"), { recursive: true });
  // a worktree-style marker (.git file) under a plain directory
  mkdirSync(join(root, "worktrees/wt"), { recursive: true });
  writeFileSync(join(root, "worktrees/wt/.git"), "gitdir: /elsewhere\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("discoverRepos", () => {
  test("finds repos at any depth and skips pruned directories", () => {
    const repos = discoverRepos(root).map((dir) => dir.slice(root.length + 1));
    expect(repos).toEqual(["projects/acme", "worktrees/wt"]);
  });

  test("maxDepth bounds the walk", () => {
    expect(discoverRepos(root, { maxDepth: 1 })).toEqual([]);
  });

  test("a non-existent root is empty, not an error", () => {
    expect(discoverRepos(join(root, "missing"))).toEqual([]);
  });
});

describe("readRepoIgnores", () => {
  test("returns the ignored paths git reports", () => {
    const { entries, error } = readRepoIgnores(join(root, "projects/acme"));
    expect(error).toBeUndefined();
    expect(entries).toEqual(["junk/"]);
  });

  test("a non-repo directory reports an error and no entries", () => {
    const { entries, error } = readRepoIgnores(join(root, "worktrees/wt"));
    expect(entries).toEqual([]);
    expect(error).toContain("git ls-files failed");
  });
});

describe("collectRepoIgnores", () => {
  test("paths are relative to the target root", () => {
    const repos = discoverRepos(root);
    const { ignores, errors } = collectRepoIgnores(root, repos);
    expect(ignores).toEqual([
      { repo: "projects/acme", entries: ["junk/"] },
      { repo: "worktrees/wt", entries: [] },
    ]);
    expect(errors).toHaveLength(1);
  });

  test("a repo at the root has an empty repo path", () => {
    const acme = join(root, "projects/acme");
    const { ignores } = collectRepoIgnores(acme, [acme]);
    expect(ignores).toEqual([{ repo: "", entries: ["junk/"] }]);
  });
});
