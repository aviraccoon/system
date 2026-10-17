import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, paths, type Settings, type Target } from "./config";
import { generateFilter, logLinesSince } from "./run";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "raccache-run-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const settings = (): Settings => ({
  powerGuard: true,
  bwLimit: "63M",
  rclone: "rclone",
  git: "git",
  include: [...DEFAULT_INCLUDE],
  exclude: [...DEFAULT_EXCLUDE],
});

describe("logLinesSince", () => {
  test("the offset is a byte count, so multibyte lines before it do not shift the slice", () => {
    const dir = tempDir();
    const file = join(dir, "log");
    writeFileSync(file, "2026/10/17 13:00:00 INFO  : přes/žluťoučký.txt: Copied (new)\n");
    const offset = statSync(file).size;
    appendFileSync(file, "2026/10/17 13:00:01 INFO  : b.txt: Copied (new)\n");
    expect(logLinesSince(file, offset)).toEqual(["2026/10/17 13:00:01 INFO  : b.txt: Copied (new)"]);
  });

  test("a missing log is empty, not an error", () => {
    expect(logLinesSince(join(tempDir(), "missing"), 0)).toEqual([]);
  });
});

describe("generateFilter", () => {
  const setup = (ignoreLines: string): { target: Target; p: ReturnType<typeof paths>; src: string } => {
    const root = tempDir();
    const src = join(root, "dev");
    const repo = join(src, "acme");
    mkdirSync(join(repo, "junk"), { recursive: true });
    writeFileSync(join(repo, ".gitignore"), "junk/\n");
    writeFileSync(join(repo, "junk/artifact.bin"), "junk\n");
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "--quiet", repo]);
    const configDir = join(root, "config");
    mkdirSync(configDir, { recursive: true });
    if (ignoreLines) writeFileSync(join(configDir, "ignore"), ignoreLines);
    const p = paths({ dir: configDir, home: root });
    return { target: { dest: "dev", src, gitignore: true }, p, src };
  };

  test("writes the exceptions, the repo's ignored paths, and the user's whole trees", () => {
    const { target, p } = setup("dev/reference/**\n");
    const { file, rules } = generateFilter(target, settings(), p);
    expect(rules.errors).toEqual([]);
    expect(rules.lines.slice(0, 3)).toEqual(["+ AGENTS.local.md", "+ CLAUDE.local.md", "+ .env"]);
    expect(rules.lines).toContain("- /acme/junk/");
    expect(rules.lines).toContain("- /reference/**");
    const written = readFileSync(file, "utf8");
    expect(written).toContain("- /acme/junk/");
    expect(written.endsWith("\n")).toBe(true);
  });

  test("surfaces an ignore line that would exclude the whole target", () => {
    const { target, p } = setup("dev/**/*\n");
    const { rules } = generateFilter(target, settings(), p);
    expect(rules.errors).toHaveLength(1);
    expect(rules.errors[0]).toContain("whole 'dev' target");
  });

  test("a target without gitignore has no repo rules", () => {
    const { target, p } = setup("");
    const { rules } = generateFilter({ ...target, gitignore: false }, settings(), p);
    expect(rules.stats.repos).toBe(0);
    expect(rules.lines.some((line) => line.includes("acme"))).toBe(false);
  });
});
