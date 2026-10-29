/**
 * Runs the deployed hook scripts against throwaway repositories.
 *
 * The scripts are the ones Nix deploys (the wrapper only prepends PATH), so
 * these tests exercise the same shell that a commit runs. Every fixture gets
 * its own HOME, so the gate's state is the test's, never the developer's.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOKS_DIR = import.meta.dir;

/** Every hook name git defines except fsmonitor-watchman (protocol output). */
const STANDARD_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "post-index-change",
  "reference-transaction",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
];

function nixSource(): string {
  return readFileSync(join(HOOKS_DIR, "default.nix"), "utf-8");
}

function nixList(name: string): string[] {
  const block = nixSource().match(new RegExp(`${name} = \\[([\\s\\S]*?)\\];`));
  if (!block) throw new Error(`default.nix has no ${name} list`);
  return [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
}

interface Fixture {
  root: string;
  repo: string;
  home: string;
  state: string;
  env: NodeJS.ProcessEnv;
}

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fx of fixtures.splice(0)) rmSync(fx.root, { recursive: true, force: true });
});

function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf-8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function git(fx: Fixture, args: string[], env: NodeJS.ProcessEnv = fx.env) {
  return runGit(fx.repo, args, env);
}

function setup(objectFormat?: "sha256"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "review-gate-hooks-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  const state = join(home, ".pi", "agent", "state");
  mkdirSync(repo, { recursive: true });
  mkdirSync(state, { recursive: true });
  const config = join(root, "gitconfig");
  writeFileSync(config, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PI_SESSION_ID: "test-session",
    GIT_AUTHOR_NAME: "Probe",
    GIT_AUTHOR_EMAIL: "probe@example.com",
    GIT_COMMITTER_NAME: "Probe",
    GIT_COMMITTER_EMAIL: "probe@example.com",
  };
  const fx: Fixture = { root, repo: realpathSync(repo), home, state, env };
  fixtures.push(fx);
  // The deployed layout: one directory holding the lib next to symlinks that
  // carry the hook names. `$0` is that name, so pass-through resolves it.
  const hooksDir = join(root, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  symlinkSync(join(HOOKS_DIR, "_lib.sh"), join(hooksDir, "_lib.sh"));
  for (const name of nixList("gateHooks")) symlinkSync(join(HOOKS_DIR, name), join(hooksDir, name));
  for (const name of nixList("passThroughHooks")) symlinkSync(join(HOOKS_DIR, "pass-through"), join(hooksDir, name));
  git(fx, ["init", "-q", "-b", "main", ...(objectFormat ? [`--object-format=${objectFormat}`] : []), "."]);
  git(fx, ["config", "user.name", "Probe"]);
  git(fx, ["config", "user.email", "probe@example.com"]);
  git(fx, ["config", "commit.gpgsign", "false"]);
  git(fx, ["config", "core.hooksPath", hooksDir]);
  return fx;
}

/** The physical path, which is what the hooks derive with `pwd -P`. */
function repoOf(fx: Fixture): string {
  return realpathSync(fx.repo);
}

function stage(fx: Fixture, name: string, content: string): void {
  writeFileSync(join(fx.repo, name), content);
  git(fx, ["add", name]);
}

function tree(fx: Fixture): string {
  return git(fx, ["write-tree"]).stdout.trim();
}

function head(fx: Fixture): string {
  const result = git(fx, ["rev-parse", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : "";
}

interface LedgerOverride {
  blocking?: boolean;
  reasons?: string[];
  override?: { reason: string; at: string };
}

function record(fx: Fixture, entryTree: string, message: string, options: LedgerOverride = {}): void {
  const entry = {
    repo: repoOf(fx),
    tree: entryTree,
    message,
    reviewedAt: new Date().toISOString(),
    verdict: {
      blocking: options.blocking ?? false,
      reasons: options.reasons ?? [],
      probabilities: {},
    },
    ...(options.override ? { override: options.override } : {}),
  };
  writeFileSync(
    join(fx.state, "review-ledger.json"),
    JSON.stringify({ version: 1, entries: { [`${entry.repo}\u0000${entry.tree}`]: entry } }, null, 2),
  );
}

function trustRepoHook(fx: Fixture, name: string): void {
  const path = join(fx.repo, ".git", "hooks", name);
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  writeFileSync(
    join(fx.state, "review-hooks-trust.json"),
    JSON.stringify({
      version: 1,
      hooks: [{ repo: repoOf(fx), hook: name, sha256, at: new Date().toISOString() }],
    }),
  );
}

function writeHook(hooksDir: string, name: string, body: string): string {
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

function installRepoHook(fx: Fixture, name: string, body: string): string {
  return writeHook(join(fx.repo, ".git", "hooks"), name, body);
}

/** What each package in the deployed hookPath provides. */
const PACKAGE_BINARIES: Record<string, string[]> = {
  git: ["git"],
  jq: ["jq"],
  coreutils: ["basename", "cat", "cut", "dirname", "mktemp", "rm", "sha256sum"],
  gnugrep: ["grep"],
  gnused: ["sed"],
};

/**
 * A PATH holding only the packages default.nix puts in front of the hooks, so
 * a command the wrapper would not find fails here first.
 */
function deployedPath(root: string): string {
  const block = nixSource().match(/hookPath = lib\.makeBinPath \[([\s\S]*?)\];/);
  if (!block) throw new Error("default.nix has no hookPath block");
  const packages = [...block[1].matchAll(/pkgs\.(\w+)/g)].map((match) => match[1]);
  const bin = join(root, "deployed-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of packages) {
    const binaries = PACKAGE_BINARIES[name];
    if (!binaries) throw new Error(`add ${name} to PACKAGE_BINARIES`);
    for (const binary of binaries) {
      const found = spawnSync("sh", ["-c", `command -v ${binary}`], { encoding: "utf-8" }).stdout.trim();
      if (!found) throw new Error(`${binary} is not on the developer PATH`);
      symlinkSync(found, join(bin, binary));
    }
  }
  return bin;
}

describe("review gate hooks", () => {
  test("a clean entry lets the commit through", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    const commit = git(fx, ["commit", "-m", "feat: add a"]);
    expect(commit.out).not.toContain("review gate");
    expect(commit.status).toBe(0);
  });

  test("no entry blocks and names the staged tree", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    const staged = tree(fx);
    const commit = git(fx, ["commit", "-m", "feat: add a"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("no clean review");
    expect(commit.out).toContain(staged.slice(0, 8));
    expect(commit.out).toContain("no review is recorded for this repository");
    expect(head(fx)).toBe("");
  });

  test("an entry for a different tree blocks and shows the delta", () => {
    const fx = setup();
    stage(fx, "a.txt", "one\n");
    const reviewed = tree(fx);
    record(fx, reviewed, "feat: add a");
    stage(fx, "a.txt", "two\n");
    const commit = git(fx, ["commit", "-m", "feat: add a"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain(`last reviewed tree: ${reviewed.slice(0, 8)}`);
    expect(commit.out).toContain("a.txt");
    // An unborn HEAD has no tree, so the refusal cannot name it as the baseline.
    expect(commit.out).not.toContain("the last review covered HEAD's tree");
  });

  test("a refusal names HEAD as the last review's baseline", () => {
    const fx = setup();
    stage(fx, "a.txt", "one\n");
    record(fx, tree(fx), "chore: one");
    expect(git(fx, ["commit", "-m", "chore: one"]).status).toBe(0);
    const headTree = git(fx, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
    // What the review tool records when the working tree is dirty and the index
    // is HEAD's tree.
    record(fx, headTree, "chore: two");
    stage(fx, "a.txt", "two\n");
    const commit = git(fx, ["commit", "-m", "chore: two"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain(`last reviewed tree: ${headTree.slice(0, 8)}`);
    expect(commit.out).toContain(`the last review covered HEAD's tree (${headTree.slice(0, 8)})`);
    expect(commit.out).toContain("so the delta above is everything since that commit");
  });

  test("a refusal whose last review covered another tree leaves HEAD out of it", () => {
    const fx = setup();
    stage(fx, "a.txt", "one\n");
    record(fx, tree(fx), "chore: one");
    expect(git(fx, ["commit", "-m", "chore: one"]).status).toBe(0);
    stage(fx, "a.txt", "two\n");
    const reviewed = tree(fx);
    record(fx, reviewed, "chore: two");
    stage(fx, "a.txt", "three\n");
    const commit = git(fx, ["commit", "-m", "chore: three"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain(`last reviewed tree: ${reviewed.slice(0, 8)}`);
    expect(commit.out).not.toContain("the last review covered HEAD's tree");
  });

  test("a changed message blocks even when the tree is reviewed", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: the reviewed subject");
    const commit = git(fx, ["commit", "-m", "feat: a different subject"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("does not match the reviewed message");
    expect(commit.out).toContain("reviewed subject: feat: the reviewed subject");
    expect(commit.out).toContain("commit subject:   feat: a different subject");
    // The refusal comes from the backstop, the only hook that sees the message
    // git will record.
    expect(commit.out).toContain("preparing");
  });

  test("a comment line is compared as written, not stripped", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    const message = "feat: add a\n\n# a line the reviewer saw";
    record(fx, tree(fx), message);
    expect(git(fx, ["commit", "-m", message]).status).toBe(0);
    expect(git(fx, ["log", "-1", "--format=%B"]).stdout).toContain("# a line the reviewer saw");

    // The reviewed message does not carry that line, so the commit must not either.
    const other = setup();
    stage(other, "a.txt", "a\n");
    record(other, tree(other), "feat: add a");
    const blocked = git(other, ["commit", "-m", "feat: add a\n\n# a line the reviewer did not see"]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.out).toContain("does not match the reviewed message");
  });

  test("a revert left staged by -n cannot commit an unreviewed tree", () => {
    const fx = setup();
    stage(fx, "a.txt", "one\n");
    record(fx, tree(fx), "feat: one");
    expect(git(fx, ["commit", "-m", "feat: one"]).status).toBe(0);
    stage(fx, "a.txt", "two\n");
    record(fx, tree(fx), "feat: two");
    expect(git(fx, ["commit", "-m", "feat: two"]).status).toBe(0);

    expect(git(fx, ["revert", "-n", "HEAD"]).status).toBe(0);
    const commit = git(fx, ["commit", "-m", 'Revert "feat: two"']);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("no clean review");
  });

  test("a message cleanup that strips git's own comments still matches", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    const file = join(fx.root, "COMMIT_EDITMSG");
    writeFileSync(file, "feat: add a\n\n# Please enter the commit message\n");
    const commit = git(fx, ["commit", "--cleanup=strip", "-F", file]);
    expect(commit.status).toBe(0);
    expect(git(fx, ["log", "-1", "--format=%B"]).stdout).not.toContain("Please enter");
  });

  test("--no-verify still hits the reference-transaction backstop", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    const commit = git(fx, ["commit", "--no-verify", "-m", "feat: add a"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("this commit's tree has no clean review");
    expect(head(fx)).toBe("");
  });

  test("--no-verify passes when the tree and message are reviewed", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    expect(git(fx, ["commit", "--no-verify", "-m", "feat: add a"]).status).toBe(0);
  });

  test("a human commit is not gated", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    const env = { ...fx.env };
    delete env.PI_SESSION_ID;
    expect(git(fx, ["commit", "-m", "feat: add a"], env).status).toBe(0);
  });

  test("the off switch and a repository exemption each let the commit through", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    writeFileSync(join(fx.state, "review-gate-off"), "{}\n");
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);

    const other = setup();
    stage(other, "a.txt", "a\n");
    writeFileSync(
      join(other.state, "review-gate-exempt.json"),
      JSON.stringify({ version: 1, repos: [{ repo: repoOf(other), at: new Date().toISOString() }] }),
    );
    expect(git(other, ["commit", "-m", "feat: add a"]).status).toBe(0);
  });

  test("a blocking verdict refuses with its reasons", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a", { blocking: true, reasons: ["behavior (behavior 0.96 ≥ 0.85)"] });
    const commit = git(fx, ["commit", "-m", "feat: add a"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("behavior 0.96");
    expect(commit.out).toContain("/review-gate override");
  });

  test("a user override lets a blocking tree commit", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a", {
      blocking: true,
      reasons: ["severity"],
      override: { reason: "the finding quoted a resolved issue", at: new Date().toISOString() },
    });
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);
  });

  test("a rewind and a branch creation are not gated", () => {
    const fx = setup();
    stage(fx, "a.txt", "one\n");
    record(fx, tree(fx), "feat: one");
    expect(git(fx, ["commit", "-m", "feat: one"]).status).toBe(0);
    stage(fx, "a.txt", "two\n");
    record(fx, tree(fx), "feat: two");
    expect(git(fx, ["commit", "-m", "feat: two"]).status).toBe(0);

    // reset --hard writes ORIG_HEAD and moves HEAD backwards through the same
    // hook; neither is a new commit being made.
    expect(git(fx, ["reset", "--hard", "HEAD~1"]).status).toBe(0);
    expect(git(fx, ["checkout", "-q", "-b", "side"]).status).toBe(0);
    expect(git(fx, ["tag", "v1"]).status).toBe(0);
    // A notes commit is new history on a ref that is not a branch; without the
    // ref-name filter it would look like an unreviewed commit.
    expect(git(fx, ["notes", "add", "-m", "note", "HEAD"]).status).toBe(0);
  });

  test("a repository hook runs before the tree check and its restaging is what the gate sees", () => {
    const fx = setup();
    installRepoHook(fx, "pre-commit", "git add extra.txt");
    trustRepoHook(fx, "pre-commit");
    writeFileSync(join(fx.repo, "extra.txt"), "extra\n");
    stage(fx, "a.txt", "a\n");

    // The tree after the repository hook adds its file; an entry only for the
    // pre-hook tree would pass if the gate ran first.
    git(fx, ["add", "extra.txt"]);
    record(fx, tree(fx), "feat: add a");
    git(fx, ["rm", "-q", "--cached", "extra.txt"]);

    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);
    expect(git(fx, ["show", "--name-only", "--format=", "HEAD"]).stdout).toContain("extra.txt");
  });

  test("an untrusted repository hook blocks an agent commit before it runs", () => {
    const fx = setup();
    const marker = join(fx.root, "hook-ran");
    installRepoHook(fx, "pre-commit", `touch ${marker}`);
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    const commit = git(fx, ["commit", "-m", "feat: add a"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("is not trusted");
    expect(commit.out).toContain("/review-gate trust-hooks");
    expect(() => readFileSync(marker)).toThrow();
  });

  test("an untrusted repository hook blocks a human commit too", () => {
    const fx = setup();
    const marker = join(fx.root, "hook-ran");
    installRepoHook(fx, "pre-commit", `touch ${marker}`);
    stage(fx, "a.txt", "a\n");
    const env = { ...fx.env };
    delete env.PI_SESSION_ID;
    const commit = git(fx, ["commit", "-m", "feat: add a"], env);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("is not trusted");
    expect(() => readFileSync(marker)).toThrow();
  });

  test("a reset back to a reflog entry and an explicit fetch are not gated", () => {
    const fx = setup();
    stage(fx, "a.txt", "one\n");
    record(fx, tree(fx), "feat: one");
    expect(git(fx, ["commit", "-m", "feat: one"]).status).toBe(0);
    // The second commit is made outside the gate, so its tree has no review:
    // only the reflog can say the forward reset lands on known history.
    const human = { ...fx.env };
    delete human.PI_SESSION_ID;
    stage(fx, "a.txt", "two\n");
    expect(git(fx, ["commit", "-m", "feat: two"], human).status).toBe(0);

    expect(git(fx, ["reset", "--hard", "HEAD~1"]).status).toBe(0);
    expect(git(fx, ["reset", "--hard", "HEAD@{1}"]).status).toBe(0);

    const origin = join(fx.root, "origin");
    mkdirSync(origin, { recursive: true });
    const originEnv = { ...fx.env, HOME: join(fx.root, "origin-home") };
    expect(runGit(origin, ["init", "-q", "-b", "main", "."], originEnv).status).toBe(0);
    writeFileSync(join(origin, "remote.txt"), "remote\n");
    runGit(origin, ["add", "remote.txt"], originEnv);
    const committed = runGit(
      origin,
      ["-c", "user.name=Probe", "-c", "user.email=probe@example.com", "commit", "-qm", "feat: remote"],
      originEnv,
    );
    expect(committed.status).toBe(0);

    expect(git(fx, ["remote", "add", "origin", origin]).status).toBe(0);
    expect(git(fx, ["fetch", "origin", "main:other"]).status).toBe(0);
  });

  test("a cherry-pick is not gated", () => {
    const fx = setup();
    stage(fx, "a.txt", "base\n");
    record(fx, tree(fx), "feat: base");
    expect(git(fx, ["commit", "-m", "feat: base"]).status).toBe(0);
    expect(git(fx, ["checkout", "-q", "-b", "feature"]).status).toBe(0);
    stage(fx, "b.txt", "feature\n");
    record(fx, tree(fx), "feat: feature");
    expect(git(fx, ["commit", "-m", "feat: feature"]).status).toBe(0);
    expect(git(fx, ["checkout", "-q", "main"]).status).toBe(0);
    stage(fx, "c.txt", "main\n");
    record(fx, tree(fx), "feat: main");
    expect(git(fx, ["commit", "-m", "feat: main"]).status).toBe(0);

    // The picked tree combines both branches and was never reviewed.
    expect(git(fx, ["cherry-pick", "feature"]).status).toBe(0);
  });

  test("--no-verify with a changed message is refused by the backstop", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: the reviewed subject");
    const commit = git(fx, ["commit", "--no-verify", "-m", "feat: another subject"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("does not match the reviewed message");
  });

  test("a sha256 repository still hits the backstop", () => {
    const fx = setup("sha256");
    stage(fx, "a.txt", "a\n");
    const commit = git(fx, ["commit", "--no-verify", "-m", "feat: add a"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("no clean review");
  });

  test("an override with no recorded message authorizes the tree", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "", {
      blocking: true,
      reasons: ["no reviewer verdict was recorded for this tree"],
      override: { reason: "the reviewer never ran", at: new Date().toISOString() },
    });
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);
  });

  test("a trusted commit-msg hook's trailer is part of the compared message", () => {
    const fx = setup();
    installRepoHook(fx, "commit-msg", 'printf "\\nReviewed-by: probe\\n" >> "$1"');
    trustRepoHook(fx, "commit-msg");
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a\n\nReviewed-by: probe");
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);
    expect(git(fx, ["log", "-1", "--format=%B"]).stdout).toContain("Reviewed-by: probe");

    // The same round without the trailer must not cover the message the hook adds.
    const other = setup();
    installRepoHook(other, "commit-msg", 'printf "\\nReviewed-by: probe\\n" >> "$1"');
    trustRepoHook(other, "commit-msg");
    stage(other, "a.txt", "a\n");
    record(other, tree(other), "feat: add a");
    const blocked = git(other, ["commit", "-m", "feat: add a"]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.out).toContain("does not match the reviewed message");
  });

  test("a repository's own post-commit hook still runs through the pass-through", () => {
    const fx = setup();
    const marker = join(fx.root, "post-commit-ran");
    installRepoHook(fx, "post-commit", `touch ${marker}`);
    trustRepoHook(fx, "post-commit");
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe("");
  });

  test("the off switch does not trust a repository hook", () => {
    const fx = setup();
    const marker = join(fx.root, "hook-ran");
    installRepoHook(fx, "pre-commit", `touch ${marker}`);
    stage(fx, "a.txt", "a\n");
    writeFileSync(join(fx.state, "review-gate-off"), "{}\n");
    const commit = git(fx, ["commit", "-m", "feat: add a"]);
    expect(commit.status).not.toBe(0);
    expect(commit.out).toContain("is not trusted");
    expect(() => readFileSync(marker)).toThrow();
  });

  test("every standard hook name is deployed", () => {
    const deployed = new Set([...nixList("gateHooks"), ...nixList("passThroughHooks")]);
    expect(STANDARD_HOOKS.filter((name) => !deployed.has(name))).toEqual([]);
    for (const name of nixList("gateHooks")) {
      expect(existsSync(join(HOOKS_DIR, name))).toBe(true);
    }
    expect(existsSync(join(HOOKS_DIR, "pass-through"))).toBe(true);
  });

  test("a merge commit is not gated", () => {
    const fx = setup();
    stage(fx, "a.txt", "base\n");
    record(fx, tree(fx), "feat: base");
    expect(git(fx, ["commit", "-m", "feat: base"]).status).toBe(0);
    expect(git(fx, ["checkout", "-q", "-b", "topic"]).status).toBe(0);
    stage(fx, "b.txt", "topic\n");
    record(fx, tree(fx), "feat: topic");
    expect(git(fx, ["commit", "-m", "feat: topic"]).status).toBe(0);
    expect(git(fx, ["checkout", "-q", "main"]).status).toBe(0);
    stage(fx, "c.txt", "main\n");
    record(fx, tree(fx), "feat: main");
    expect(git(fx, ["commit", "-m", "feat: main"]).status).toBe(0);

    expect(git(fx, ["merge", "--no-ff", "-m", "merge topic", "topic"]).status).toBe(0);
  });

  test("a repository reference-transaction hook receives git's ref lines", () => {
    const fx = setup();
    const log = join(fx.root, "ref-tx.log");
    writeHook(join(fx.repo, ".git", "hooks"), "reference-transaction", `cat >> ${log}`);
    trustRepoHook(fx, "reference-transaction");
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);
    expect(readFileSync(log, "utf-8")).toContain("refs/heads/main");
  });

  test("an untrusted hook that does not decide the commit is skipped, not fatal", () => {
    const fx = setup();
    const marker = join(fx.root, "checkout-ran");
    installRepoHook(fx, "post-checkout", `touch ${marker}`);
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);

    const env = { ...fx.env };
    delete env.PI_SESSION_ID;
    const checkout = git(fx, ["switch", "-q", "-c", "side"], env);
    expect(checkout.status).toBe(0);
    expect(checkout.out).toContain("skipping");
    expect(() => readFileSync(marker)).toThrow();
  });

  test("a bare repository with a server-side hook still accepts a push", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    expect(git(fx, ["commit", "-m", "feat: add a"]).status).toBe(0);

    const bare = join(fx.root, "server.git");
    expect(runGit(fx.root, ["init", "-q", "--bare", bare], fx.env).status).toBe(0);
    expect(runGit(bare, ["config", "core.hooksPath", join(fx.root, "hooks")], fx.env).status).toBe(0);
    writeHook(join(bare, "hooks"), "pre-receive", "cat >/dev/null");

    expect(git(fx, ["remote", "add", "server", bare]).status).toBe(0);
    const push = git(fx, ["push", "server", "main"]);
    expect(push.status).toBe(0);
    expect(push.out).toContain("no worktree to key trust on");
  });

  test("the hooks run with only the packages the deployed PATH provides", () => {
    const fx = setup();
    stage(fx, "a.txt", "a\n");
    record(fx, tree(fx), "feat: add a");
    const commit = git(fx, ["commit", "-m", "feat: add a"], { ...fx.env, PATH: deployedPath(fx.root) });
    expect(commit.out).not.toContain("not found");
    expect(commit.status).toBe(0);

    // A refusal prints the delta through the same tools.
    const other = setup();
    stage(other, "a.txt", "one\n");
    record(other, tree(other), "feat: one");
    stage(other, "a.txt", "two\n");
    const blocked = git(other, ["commit", "-m", "feat: one"], { ...other.env, PATH: deployedPath(other.root) });
    expect(blocked.out).not.toContain("not found");
    expect(blocked.status).not.toBe(0);
    expect(blocked.out).toContain("unreviewed delta");
  });
});
