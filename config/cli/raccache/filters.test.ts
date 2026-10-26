import { describe, expect, test } from "bun:test";
import { buildFilters, escapeGlob, renderFilter, sliceRule } from "./filters";

const base = { dest: "dev", include: ["AGENTS.local.md"], exclude: [".DS_Store"], userIgnore: [] };

describe("escapeGlob", () => {
  test("escapes rclone wildcards, leaves plain paths alone", () => {
    expect(escapeGlob("plain/path/file.txt")).toBe("plain/path/file.txt");
    expect(escapeGlob("weird[1] {a,b}?.txt")).toBe("weird\\[1\\] \\{a,b\\}\\?.txt");
    expect(escapeGlob("back\\slash")).toBe("back\\\\slash");
  });
});

describe("--path slices", () => {
  test("the slice rule follows the target's rules and the catch-all is last", () => {
    const { lines, stats } = buildFilters({
      ...base,
      repoIgnores: [{ repo: "acme", entries: ["junk/"] }],
      userIgnore: ["dev/third-party/**"],
      slice: ["Downloads/6c1.png"],
    });
    expect(lines.at(-1)).toBe("- /**");
    expect(lines.indexOf("+ /Downloads/6c1.png")).toBeGreaterThan(lines.indexOf("- .DS_Store"));
    expect(stats.slice).toBe(1);
  });

  test("the target's own rules still exclude inside the slice", () => {
    const { lines } = buildFilters({
      ...base,
      repoIgnores: [{ repo: "acme", entries: ["node_modules/"] }],
      userIgnore: ["dev/third-party/**"],
      slice: ["third-party/acme/"],
    });
    expect(lines.indexOf("- .DS_Store")).toBeLessThan(lines.indexOf("+ /third-party/acme/**"));
    expect(lines.indexOf("- /acme/node_modules/")).toBeLessThan(lines.indexOf("+ /third-party/acme/**"));
    expect(lines.indexOf("- /third-party/**")).toBeLessThan(lines.indexOf("+ /third-party/acme/**"));
  });

  test("a trailing slash means the subtree, a leading slash is optional", () => {
    expect(sliceRule("/Pictures/").rule).toBe("+ /Pictures/**");
    expect(sliceRule("Pictures").rule).toBe("+ /Pictures");
    expect(sliceRule("  a/b  ").rule).toBe("+ /a/b");
    expect(sliceRule("./Pictures/").rule).toBe("+ /Pictures/**");
  });

  test("an empty entry or a relative segment is refused", () => {
    expect(sliceRule("").error).toContain("empty");
    expect(sliceRule("/").error).toContain("empty");
    expect(sliceRule("a/../b").error).toContain("relative");
    expect(sliceRule("a/./b").error).toContain("relative");
    expect(buildFilters({ ...base, userIgnore: [], slice: ["a/../b"] }).errors).toHaveLength(1);
  });
});
describe("buildFilters", () => {
  test("include exceptions precede excludes", () => {
    const { lines } = buildFilters({ ...base, repoIgnores: [] });
    expect(lines).toEqual(["+ AGENTS.local.md", "- .DS_Store"]);
  });

  test("directory entries become directory rules, files stay file rules", () => {
    const { lines, stats } = buildFilters({
      ...base,
      repoIgnores: [{ repo: "acme/widgets", entries: [".pnpm-store/", "AGENTS.local.md", "model/.DS_Store"] }],
    });
    expect(lines).toContain("- /acme/widgets/.pnpm-store/");
    expect(lines).toContain("- /acme/widgets/AGENTS.local.md");
    expect(lines).toContain("- /acme/widgets/model/.DS_Store");
    expect(stats.gitignore).toBe(3);
    expect(stats.repos).toBe(1);
  });

  test("a repo at the target root has no extra path segment", () => {
    const { lines } = buildFilters({ ...base, repoIgnores: [{ repo: "", entries: ["node_modules/"] }] });
    expect(lines).toContain("- /node_modules/");
  });

  test("wildcards in git paths are escaped", () => {
    const { lines } = buildFilters({ ...base, repoIgnores: [{ repo: "x", entries: ["weird[1].txt"] }] });
    expect(lines).toContain("- /x/weird\\[1\\].txt");
  });

  test("duplicate rules collapse and stats count emitted rules", () => {
    const { lines, stats } = buildFilters({
      ...base,
      include: ["AGENTS.local.md", "AGENTS.local.md"],
      repoIgnores: [
        { repo: "a", entries: [".DS_Store"] },
        { repo: "b", entries: [".DS_Store"] },
      ],
    });
    expect(stats.include).toBe(1);
    expect(stats.gitignore).toBe(2);
    expect(lines.filter((line) => line === "+ AGENTS.local.md")).toHaveLength(1);
  });

  test("user lines are namespaced by dest and skipped for other targets", () => {
    const { lines, stats, errors } = buildFilters({
      ...base,
      dest: "dev",
      userIgnore: ["# comment", "", "dev/reference/**", "Documents/secret/**", "/dev/tmp/", "~/dev/scratch/*"],
    });
    expect(errors).toEqual([]);
    expect(lines).toContain("- /reference/**");
    expect(lines).toContain("- /tmp/");
    expect(lines).toContain("- /scratch/*");
    expect(lines.some((line) => line.includes("secret"))).toBe(false);
    expect(stats.user).toBe(3);
  });

  test("a user line naming the whole target is refused", () => {
    for (const line of [
      "dev",
      "dev/",
      "dev/**",
      "dev/*",
      "dev/*/**",
      "dev/**/*",
      "dev/**/**",
      "dev/**?",
      "dev/*?",
      "dev/{*,*}",
    ]) {
      const { errors, lines } = buildFilters({ ...base, userIgnore: [`${line}`] });
      expect(errors).toHaveLength(1);
      expect(lines.some((rule) => rule.startsWith("- /") && rule.length <= 5)).toBe(false);
    }
  });

  test("relative segments in user lines are refused", () => {
    const { errors } = buildFilters({ ...base, userIgnore: ["dev/../Documents/**"] });
    expect(errors[0]).toContain("relative path segment");
  });

  test("a nested dest namespaces on its whole path", () => {
    const { lines } = buildFilters({ ...base, dest: "iCloud/Obsidian", userIgnore: ["iCloud/Obsidian/.trash/**"] });
    expect(lines).toContain("- /.trash/**");
  });
});

describe("renderFilter", () => {
  test("adds a header and trailing newline", () => {
    const text = renderFilter("dev", ["+ AGENTS.local.md", "- .DS_Store"]);
    expect(text.startsWith("# raccache filters for 'dev'")).toBe(true);
    expect(text.endsWith("- .DS_Store\n")).toBe(true);
  });
});
