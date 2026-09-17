import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAtMentions } from "../shared/at-mentions";
import { resolveAtMention } from "./resolve.js";

const TEST_DIR = join(tmpdir(), `at-mentions-test-${process.pid}`);

describe("extractAtMentions", () => {
  test("extracts simple @path", () => {
    expect(extractAtMentions("look at @src/foo.ts")).toEqual(["src/foo.ts"]);
  });

  test("extracts quoted @path with spaces", () => {
    expect(extractAtMentions('@"path with spaces/file.ts"')).toEqual(["path with spaces/file.ts"]);
  });

  test("extracts multiple @paths", () => {
    expect(extractAtMentions("compare @src/a.ts and @lib/b.ts")).toEqual(["src/a.ts", "lib/b.ts"]);
  });

  test("extracts directory @path", () => {
    expect(extractAtMentions("list @modules/home-manager/")).toEqual(["modules/home-manager/"]);
  });

  test("ignores bare words without path separators or dots", () => {
    expect(extractAtMentions("hey @alice how are you")).toEqual([]);
  });

  test("handles mixed mentions and non-mentions", () => {
    expect(extractAtMentions("@someone look at @src/file.ts")).toEqual(["src/file.ts"]);
  });

  test("extracts path with dots but no slash", () => {
    expect(extractAtMentions("check @package.json")).toEqual(["package.json"]);
  });

  test("returns empty for no mentions", () => {
    expect(extractAtMentions("just regular text")).toEqual([]);
  });
});

describe("resolveAtMention", () => {
  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("reads file and wraps in <file> tag", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(join(TEST_DIR, "foo.ts"), "const x = 1;");

    const result = resolveAtMention("foo.ts", TEST_DIR);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("file");
    expect(result?.content).toBe('<file name="foo.ts">\nconst x = 1;\n</file>');
  });

  test("lists directory contents", () => {
    const subdir = join(TEST_DIR, "mydir");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "a.ts"), "");
    writeFileSync(join(subdir, "b.ts"), "");
    mkdirSync(join(subdir, "nested"));

    const result = resolveAtMention("mydir", TEST_DIR);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("directory");
    expect(result?.content).toContain("a.ts");
    expect(result?.content).toContain("b.ts");
    expect(result?.content).toContain("nested/");
  });

  test("returns null for nonexistent path", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    expect(resolveAtMention("nope.ts", TEST_DIR)).toBeNull();
  });

  test("directory listing shows trailing slash for dirs", () => {
    const subdir = join(TEST_DIR, "proj");
    mkdirSync(join(subdir, "src"), { recursive: true });
    writeFileSync(join(subdir, "README.md"), "");

    const result = resolveAtMention("proj", TEST_DIR);
    expect(result).not.toBeNull();
    const lines = result?.content.split("\n");
    expect(lines?.some((l) => l === "src/")).toBe(true);
    expect(lines?.some((l) => l === "README.md")).toBe(true);
  });
});
