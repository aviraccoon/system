import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showRunProgress } from "./collect";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, paths, type Settings, type Target } from "./config";
import { parseRunProgress } from "./format";
import { generateFilter, logLinesSince, pairLabels, pairMessages, startLine } from "./run";

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

describe("startLine", () => {
  const target: Target = { dest: "dev", src: "/home/example/dev", gitignore: false };
  const destination = { name: "b2", remote: "b2crypt:laptop", mode: "mirror" as const, flags: [] };

  test("round-trips through the parser, including a narrowed pass", () => {
    const planned = pairLabels([target], [destination]);
    expect(planned).toEqual(["b2/dev"]);
    const text = `2026-10-17T05:00:00.000Z ${startLine(planned, false)}\n`;
    expect(parseRunProgress(text, [], Date.parse("2026-10-17T05:05:00.000Z"))).toBe("1 of 1 (b2/dev) · 5m elapsed");
  });

  test("keeps the dry-run marker out of the pair list", () => {
    const planned = pairLabels([target], [destination]);
    const text = `2026-10-17T05:00:00.000Z ${startLine(planned, true)}\n`;
    expect(text).toContain("1 pair, dry run:");
    expect(parseRunProgress(text, [], Date.parse("2026-10-17T05:01:00.000Z"))).toBe("1 of 1 (b2/dev) · 1m elapsed");
  });
});

describe("pairLabels and pairMessages", () => {
  const targets: Target[] = [
    { dest: "dev", src: "/home/example/dev", gitignore: true },
    { dest: "Documents", src: "/home/example/Documents", gitignore: false },
  ];
  const destinations = [
    { name: "b2", remote: "b2crypt:laptop", mode: "mirror" as const, flags: [] },
    { name: "r2", remote: "r2crypt:laptop", mode: "copy" as const, flags: [] },
  ];

  test("pairs are target-major, matching the runner's loop order", () => {
    expect(pairLabels(targets, destinations)).toEqual(["b2/dev", "r2/dev", "b2/Documents", "r2/Documents"]);
  });

  test("every failure line the runner writes ends its pair", () => {
    const stamped = pairMessages(destinations, "dev", "FAILED to build filters: boom").map(
      (line) => `2026-10-17T05:00:10.000Z ${line}`,
    );
    const text = `2026-10-17T05:00:00.000Z ${startLine(pairLabels(targets, destinations), false)}\n${stamped.join("\n")}\n`;
    expect(parseRunProgress(text, [], Date.parse("2026-10-17T05:03:00.000Z"))).toBe(
      "3 of 4 (b2/Documents) · 3m elapsed",
    );
  });

  test("a per-target failure ends that pair for every destination", () => {
    expect(pairMessages(destinations, "dev", "ABORTED: on battery power")).toEqual([
      "b2/dev ABORTED: on battery power",
      "r2/dev ABORTED: on battery power",
    ]);
  });
});

describe("showRunProgress", () => {
  test("needs a live runner and a plan", () => {
    expect(showRunProgress(null, ["b2/dev"])).toBe(false);
    expect(showRunProgress("123", [])).toBe(false);
    expect(showRunProgress("123", ["b2/dev"])).toBe(true);
  });
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
