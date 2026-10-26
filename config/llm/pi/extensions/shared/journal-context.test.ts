import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarvestBlock,
  buildJournalContext,
  buildJournalParts,
  type JournalConfig,
  journalDirFor,
  journalNotesDir,
  loadHarvestPolicy,
  projectFor,
  resolvePart,
} from "./journal-context";

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

  it("a bare flag yields the policy only", () => {
    expect(buildHarvestBlock(policy, {})).toBe("POLICY");
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

/** A config over a temp notes tree; both builder suites start from it. */
function config(notesDir: string): JournalConfig {
  return {
    notesDir,
    noNotesReminder: "NO NOTES",
    journalReminder: "JOURNAL REMINDER",
    compactionReminder: "COMPACT",
    journalSkipMessage: "SKIP",
    vanillaMessage: "VANILLA",
    globalInstructions: "GLOBAL",
  };
}

describe("buildJournalParts with a harvest flag", () => {
  /** A notes tree with one project carrying `meta`. */
  function notesTree(meta: unknown): string {
    const notesDir = mkdtempSync(join(tmpdir(), "jc-harvest-"));
    mkdirSync(join(notesDir, "acme"));
    writeFileSync(join(notesDir, "acme", "meta.json"), JSON.stringify(meta));
    return notesDir;
  }

  it("builds the block for the object form and keeps its note", async () => {
    const parts = await buildJournalParts(config(notesTree({ harvest: { note: "alias acme" } })), "/code/acme");
    expect(parts.metadata).toContain("Time tracking");
    expect(parts.metadata).toContain("alias acme");
  });

  it("drops a note that is not a string, keeps the policy and says so", async () => {
    const parts = await buildJournalParts(config(notesTree({ harvest: { note: 5 } })), "/code/acme");
    expect(parts.metadata).toContain("Time tracking");
    expect(parts.metadata).not.toContain("Project notes");
    expect(parts.projectSettings).toContain("`harvest.note`");
  });

  it("builds no block, does not throw and reports a null flag", async () => {
    const parts = await buildJournalParts(config(notesTree({ harvest: null })), "/code/acme");
    expect(parts.metadata).not.toContain("Time tracking");
    expect(parts.projectSettings).toContain("`harvest`");
  });
});

describe("projectFor", () => {
  it("names and locates a plain project", () => {
    expect(projectFor("/notes/llm", "/code/acme")).toEqual({ name: "acme", dir: "/notes/llm/acme" });
  });

  it("resolves a worktree session to the main project's dir", () => {
    expect(projectFor("/notes/llm", "/code/acme.worktrees/feat/x")).toEqual({
      name: "acme",
      dir: "/notes/llm/acme",
    });
  });
});

describe("buildJournalParts with declared instructions", () => {
  /** A notes tree with one project that declares `instructions`. */
  function notesTree(note?: string): string {
    const notesDir = mkdtempSync(join(tmpdir(), "jc-parts-"));
    const projectDir = join(notesDir, "acme");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "work-rules.md"), "RULE BODY");
    writeFileSync(
      join(projectDir, "meta.json"),
      JSON.stringify({ description: "d", path: "~/code/acme", instructions: ["work-rules.md"] }),
    );
    if (note) writeFileSync(join(projectDir, "2026-01-01-01-note.md"), note);
    return notesDir;
  }

  it("inlines the file in its own part, leaving the global instructions alone", async () => {
    const parts = await buildJournalParts(config(notesTree()), "/code/acme");
    expect(parts.projectSettings).toContain("RULE BODY");
    expect(parts.instructions).toContain("GLOBAL");
    expect(parts.instructions).not.toContain("RULE BODY");
    expect(parts.instructions).toContain("JOURNAL REMINDER");
  });

  it("keeps the whole context in the same order the parts are read in", async () => {
    const context = await buildJournalContext(config(notesTree()), "/code/acme");
    expect(context.indexOf("GLOBAL")).toBeLessThan(context.indexOf("RULE BODY"));
    expect(context.indexOf("RULE BODY")).toBeLessThan(context.indexOf("No previous session notes"));
  });

  it("loads for a worktree cwd through the main project's meta.json", async () => {
    const parts = await buildJournalParts(config(notesTree()), "/code/acme.worktrees/feat/x");
    expect(parts.projectSettings).toContain("RULE BODY");
  });

  it("still loads under NO_JOURNAL=1, because they are rules and not notes", async () => {
    const prev = process.env.NO_JOURNAL;
    process.env.NO_JOURNAL = "1";
    try {
      const parts = await buildJournalParts(config(notesTree()), "/code/acme");
      expect(parts.projectSettings).toContain("RULE BODY");
      expect(parts.instructions).toContain("SKIP");
      expect(parts.metadata).toBe("");
    } finally {
      if (prev === undefined) delete process.env.NO_JOURNAL;
      else process.env.NO_JOURNAL = prev;
    }
  });

  it("reports an unparseable meta.json instead of silently dropping its instructions", async () => {
    const notesDir = notesTree();
    writeFileSync(join(notesDir, "acme", "meta.json"), '{ "instructions": [ "work-rules.md" ], }');
    const parts = await buildJournalParts(config(notesDir), "/code/acme");
    expect(parts.projectSettings).toContain("could not be read as JSON");
  });

  it("reports an `instructions` value that is not an array", async () => {
    const notesDir = notesTree();
    writeFileSync(join(notesDir, "acme", "meta.json"), JSON.stringify({ instructions: "work-rules.md" }));
    const parts = await buildJournalParts(config(notesDir), "/code/acme");
    expect(parts.projectSettings).toContain("must be an array");
  });

  it("names the real fault for a valid meta.json whose top level is not an object", async () => {
    const notesDir = notesTree();
    writeFileSync(join(notesDir, "acme", "meta.json"), JSON.stringify(["work-rules.md"]));
    const parts = await buildJournalParts(config(notesDir), "/code/acme");
    expect(parts.projectSettings).toContain("must be an object");
    expect(parts.projectSettings).not.toContain("could not be read as JSON");
  });

  it("exposes the project part under the name the Claude Code hook passes", async () => {
    const parts = await buildJournalParts(config(notesTree()), "/code/acme");
    expect(resolvePart(parts, "project-settings")).toContain("RULE BODY");
  });

  it("makes a misspelled part name visible instead of injecting nothing", async () => {
    const parts = await buildJournalParts(config(notesTree()), "/code/acme");
    expect(resolvePart(parts, "project-instruction")).toBe("unknown context part: project-instruction");
    expect(resolvePart(parts, "journal:abc")).toBe("unknown context part: journal:abc");
    expect(resolvePart(parts, "journal:")).toBe("unknown context part: journal:");
  });

  it("resolves an in-range journal index to its entry", async () => {
    const parts = await buildJournalParts(config(notesTree("NOTE BODY")), "/code/acme");
    expect(resolvePart(parts, "journal:0")).toContain("NOTE BODY");
  });

  it("keeps a valid journal index past the end empty", async () => {
    const parts = await buildJournalParts(config(notesTree("NOTE BODY")), "/code/acme");
    expect(resolvePart(parts, "journal:2")).toBe("");
  });

  it("names the entry whose key is wrong instead of loading the rest silently", async () => {
    const notesDir = notesTree();
    writeFileSync(
      join(notesDir, "acme", "meta.json"),
      JSON.stringify({ instructions: ["work-rules.md", { file: "other.md" }] }),
    );
    const parts = await buildJournalParts(config(notesDir), "/code/acme");
    expect(parts.projectSettings).toContain("entry 2");
    expect(parts.projectSettings).toContain("no `path` string");
  });

  it("names an entry whose `subagents` marker is not a boolean", async () => {
    const notesDir = notesTree();
    writeFileSync(
      join(notesDir, "acme", "meta.json"),
      JSON.stringify({ instructions: [{ path: "work-rules.md", subagents: "true" }] }),
    );
    const parts = await buildJournalParts(config(notesDir), "/code/acme");
    expect(parts.projectSettings).toContain("`subagents`");
    expect(parts.projectSettings).not.toContain("RULE BODY");
  });
});
