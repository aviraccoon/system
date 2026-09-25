import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { stashWriteContent } from "./stash";

describe("stashWriteContent", () => {
  test("writes a 0600 file inside a private mkdtemp dir", () => {
    const path = stashWriteContent("docs/README.md", "content");
    expect(dirname(path)).not.toBe(tmpdir());
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("sanitizes the target name and falls back when it empties", () => {
    const path = stashWriteContent("a/b/$(id).md", "content");
    expect(path).toContain("a-b---id-.md");
    expect(stashWriteContent("", "content").endsWith("blocked-write")).toBe(true);
    // A dot-only name would join() to the parent dir — collapse to the fallback.
    expect(stashWriteContent("..", "content").endsWith("blocked-write")).toBe(true);
  });
});
