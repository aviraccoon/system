import { describe, expect, test } from "bun:test";
import { isGatedProsePath, mentionsWritingStyleSkill, proseGateReason } from "./prose-gate";

const roots = {
  cwd: "/Users/foo/bar-project",
  notesDir: "/Users/foo/notes/journal",
  sessionsDir: "/Users/foo/.pi/agent/records",
};

describe("isGatedProsePath", () => {
  test("gates markdown and text-first prose formats", () => {
    expect(isGatedProsePath("/Users/foo/bar-project/README.md", roots)).toBe(true);
    expect(isGatedProsePath("/Users/foo/bar-project/docs/guide.mdx", roots)).toBe(true);
    expect(isGatedProsePath("/Users/foo/bar-project/docs/manual.rst", roots)).toBe(true);
    expect(isGatedProsePath("/Users/foo/bar-project/notes.txt", roots)).toBe(true);
  });

  test("does not gate non-prose files", () => {
    expect(isGatedProsePath("/Users/foo/bar-project/src/index.ts", roots)).toBe(false);
    expect(isGatedProsePath("/Users/foo/bar-project/data.json", roots)).toBe(false);
  });

  test("exempts journal and session trees", () => {
    expect(isGatedProsePath("/Users/foo/notes/journal/bar-project/TODO.md", roots)).toBe(false);
    expect(isGatedProsePath("/Users/foo/notes/journal/bar-project/2026-01-01-01-topic.md", roots)).toBe(false);
    expect(isGatedProsePath("/Users/foo/.pi/agent/records/x/session.md", roots)).toBe(false);
  });

  test("exemption is by path prefix, not string prefix", () => {
    expect(isGatedProsePath("/Users/foo/notes/journal-other/README.md", roots)).toBe(true);
  });
});

describe("mentionsWritingStyleSkill", () => {
  test("matches any spelling containing the skill dir and file", () => {
    expect(mentionsWritingStyleSkill("/Users/foo/.pi/agent/skills/writing-style/SKILL.md")).toBe(true);
    expect(mentionsWritingStyleSkill("cat ~/.pi/agent/skills/writing-style/SKILL.md")).toBe(true);
    expect(mentionsWritingStyleSkill("cd ~/.pi/agent/skills/writing-style && cat SKILL.md")).toBe(true);
  });

  test("does not match other skills or partial references", () => {
    expect(mentionsWritingStyleSkill("/Users/foo/.pi/agent/skills/algo-practice/SKILL.md")).toBe(false);
    expect(mentionsWritingStyleSkill("read the SKILL.md")).toBe(false);
  });
});

describe("messages", () => {
  test("reason names the skill path", () => {
    expect(proseGateReason("README.md")).toContain("writing-style/SKILL.md");
  });
});
