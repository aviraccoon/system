import { describe, expect, test } from "bun:test";
import {
  isGatedProsePath,
  mentionsWritingStyleSkill,
  proseGateReason,
  type SkillHistoryEntry,
  type SkillHistorySource,
  skillLoadedFromHistory,
  skillLoadedThisSession,
} from "./prose-gate";

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

const skillPath = "/Users/foo/.pi/agent/skills/writing-style/SKILL.md";

function assistantCall(id: string, name: string, args: Record<string, unknown>): SkillHistoryEntry {
  return {
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
  };
}

function toolResult(id: string, isError: boolean): SkillHistoryEntry {
  return { type: "message", message: { role: "toolResult", toolCallId: id, isError, content: [] } };
}

describe("skillLoadedFromHistory", () => {
  test("a read of the skill with a successful result counts as loaded", () => {
    expect(skillLoadedFromHistory([assistantCall("t1", "read", { path: skillPath }), toolResult("t1", false)])).toBe(
      true,
    );
  });

  test("an errored read does not count", () => {
    expect(skillLoadedFromHistory([assistantCall("t1", "read", { path: skillPath }), toolResult("t1", true)])).toBe(
      false,
    );
  });

  test("a shell command referencing the skill counts as loaded", () => {
    expect(
      skillLoadedFromHistory([assistantCall("t1", "bash", { command: `cat ${skillPath}` }), toolResult("t1", false)]),
    ).toBe(true);
  });

  test("an unpaired read does not count", () => {
    expect(skillLoadedFromHistory([assistantCall("t1", "read", { path: skillPath })])).toBe(false);
  });

  test("reads of other files and write calls do not count", () => {
    expect(
      skillLoadedFromHistory([
        assistantCall("t1", "read", { path: "/Users/foo/bar-project/README.md" }),
        toolResult("t1", false),
      ]),
    ).toBe(false);
    expect(
      skillLoadedFromHistory([
        assistantCall("t1", "write", { path: skillPath, content: "x" }),
        toolResult("t1", false),
      ]),
    ).toBe(false);
  });

  test("order-independent", () => {
    expect(skillLoadedFromHistory([toolResult("t1", false), assistantCall("t1", "read", { path: skillPath })])).toBe(
      true,
    );
  });

  test("non-message entries are ignored", () => {
    expect(skillLoadedFromHistory([{ type: "model_change" }, { type: "message", message: { role: "user" } }])).toBe(
      false,
    );
  });
});

describe("skillLoadedThisSession", () => {
  const readPair: SkillHistoryEntry[] = [assistantCall("t1", "read", { path: skillPath }), toolResult("t1", false)];

  test("scans the compaction-filtered context, not the raw branch", () => {
    // buildContextEntries deliberately returns a different set than
    // getBranch: a true result here would prove the helper read the wrong
    // source (getBranch still holds entries a compaction summarized away).
    const session: SkillHistorySource & { getBranch: () => SkillHistoryEntry[] } = {
      buildContextEntries: () => [],
      getBranch: () => readPair,
    };
    expect(skillLoadedThisSession(session)).toBe(false);
  });

  test("a skill read in the context counts as loaded", () => {
    expect(skillLoadedThisSession({ buildContextEntries: () => readPair })).toBe(true);
  });
});
