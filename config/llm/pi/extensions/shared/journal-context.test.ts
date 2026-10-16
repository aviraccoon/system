import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildHarvestBlock, journalDirFor, journalNotesDir, loadHarvestPolicy } from "./journal-context";

describe("loadHarvestPolicy", () => {
  it("reads the sibling policy file", () => {
    const policy = loadHarvestPolicy();
    expect(policy).toContain("`harvest` CLI");
    expect(policy).toContain("--offset");
    expect(policy).toContain("--help");
  });

  it("carries no entry/note policy — company specifics live in meta.json notes", () => {
    const policy = loadHarvestPolicy();
    expect(policy).not.toContain("Every entry needs a note");
    expect(policy).not.toContain("work thread");
    expect(policy).not.toMatch(/https?:\/\//);
  });
});

describe("buildHarvestBlock", () => {
  const policy = "POLICY";

  it("true flag yields the policy only", () => {
    expect(buildHarvestBlock(policy, true)).toBe("POLICY");
  });

  it("object with note appends it verbatim", () => {
    expect(buildHarvestBlock(policy, { note: "Use alias acme.\nTask ? = ask first." })).toBe(
      "POLICY\nProject notes: Use alias acme.\nTask ? = ask first.",
    );
  });

  it("whitespace-only note is dropped", () => {
    expect(buildHarvestBlock(policy, { note: "   " })).toBe("POLICY");
  });
});

describe("journalDirFor", () => {
  const notesDir = "/notes/llm";

  it("uses the cwd basename for a plain project path", () => {
    expect(journalDirFor(notesDir, "/Users/foo/code/bar-project")).toBe(join(notesDir, "bar-project"));
  });

  it("resolves a worktree to the main project via the .worktrees ancestor", () => {
    expect(journalDirFor(notesDir, "/Users/foo/code/bar-project.worktrees/feat/system")).toBe(
      join(notesDir, "bar-project"),
    );
  });

  it("resolves a cwd under a bare .worktrees container to the repo dir", () => {
    expect(journalDirFor(notesDir, "/Users/foo/code/bar-project/.worktrees/feat/x")).toBe(
      join(notesDir, "bar-project"),
    );
  });

  it("falls back to the basename dir when nothing matches", () => {
    expect(journalDirFor(notesDir, "/Users/foo/code/new-project")).toBe(join(notesDir, "new-project"));
  });

  it("names the root project when cwd has no basename", () => {
    expect(journalDirFor(notesDir, "/")).toBe(join(notesDir, "root"));
  });
});

describe("journalNotesDir", () => {
  it("falls back to ~/notes/llm when the config is missing", () => {
    const prev = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "jc-notes-"));
    try {
      expect(journalNotesDir()).toBe(join(homedir(), "notes", "llm"));
    } finally {
      if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prev;
    }
  });
});
