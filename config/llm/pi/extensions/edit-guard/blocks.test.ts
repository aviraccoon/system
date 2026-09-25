import { describe, expect, test } from "bun:test";
import { proseGateBlock, rewriteBlock } from "./blocks";

describe("proseGateBlock", () => {
  test("base reason names the skill path", () => {
    const reason = proseGateBlock("README.md", "/Users/foo/bar-project/README.md");
    expect(reason).toContain("writing-style/SKILL.md");
    expect(reason).not.toContain("blocked content");
  });

  test("stash note emits a shell-quoted cp command", () => {
    const reason = proseGateBlock(
      "README.md",
      "/Users/foo/bar-project/docs/$(id).md",
      "/tmp/edit-guard-write-abc123/README.md",
    );
    expect(reason).toContain("cp '/tmp/edit-guard-write-abc123/README.md' '/Users/foo/bar-project/docs/$(id).md'");
  });

  test("target paths with single quotes are escaped", () => {
    const reason = proseGateBlock("odd.md", "/Users/foo/bar-project/it's.md", "/tmp/stash");
    expect(reason).toContain("'\\''");
    expect(reason).toContain("cp '/tmp/stash' '/Users/foo/bar-project/it'\\''s.md'");
  });
});

describe("rewriteBlock", () => {
  test("base reason points at patch without a stash sentence", () => {
    const reason = rewriteBlock("README.md", 107, "/Users/foo/bar-project/README.md");
    expect(reason).toContain("already exists (107 lines)");
    expect(reason).toContain("use patch for targeted changes");
    expect(reason).not.toContain("blocked content");
  });

  test("stash note emits a shell-quoted cp command", () => {
    const reason = rewriteBlock("README.md", 107, "/Users/foo/bar-project/a$b.md", "/tmp/edit-guard-write-x/README.md");
    expect(reason).toContain("cp '/tmp/edit-guard-write-x/README.md' '/Users/foo/bar-project/a$b.md'");
  });
});
