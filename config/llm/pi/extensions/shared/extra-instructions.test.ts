import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandInstructionPath,
  formatInstructions,
  instructionPaths,
  MISSING_INSTRUCTION,
  projectInstructions,
} from "./extra-instructions";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("instructionPaths", () => {
  it("a plain string loads for the main agent only", () => {
    expect(instructionPaths(["a.md"], "main")).toEqual(["a.md"]);
    expect(instructionPaths(["a.md"], "subagent")).toEqual([]);
  });

  it("the object form with subagents:true loads for both audiences", () => {
    const entries = [{ path: "a.md", subagents: true }];
    expect(instructionPaths(entries, "main")).toEqual(["a.md"]);
    expect(instructionPaths(entries, "subagent")).toEqual(["a.md"]);
  });

  it("the object form without the flag stays main-only", () => {
    expect(instructionPaths([{ path: "a.md" }], "subagent")).toEqual([]);
    expect(instructionPaths([{ path: "a.md", subagents: false }], "subagent")).toEqual([]);
  });

  it("drops malformed entries instead of failing the session", () => {
    expect(instructionPaths([null, 42, {}, { path: "" }, "ok.md"], "main")).toEqual(["ok.md"]);
  });

  it("is empty for a missing or non-array value", () => {
    expect(instructionPaths(undefined, "main")).toEqual([]);
    expect(instructionPaths("a.md", "main")).toEqual([]);
    expect(instructionPaths({ path: "a.md" }, "main")).toEqual([]);
  });

  it("deduplicates while keeping declaration order", () => {
    expect(instructionPaths(["b.md", "a.md", "b.md"], "main")).toEqual(["b.md", "a.md"]);
  });
});

describe("expandInstructionPath", () => {
  it("expands a leading ~/ to the home directory", () => {
    expect(expandInstructionPath("~/notes/x.md", "/base")).toBe(join(homedir(), "notes/x.md"));
  });

  it("expands a bare ~", () => {
    expect(expandInstructionPath("~", "/base")).toBe(homedir());
  });

  it("resolves a relative path against the project dir", () => {
    expect(expandInstructionPath("cards/../rules.md", "/notes/proj")).toBe("/notes/proj/rules.md");
  });

  it("leaves an absolute path alone", () => {
    expect(expandInstructionPath("/etc/rules.md", "/base")).toBe("/etc/rules.md");
  });
});

describe("formatInstructions", () => {
  it("returns an empty string when nothing is declared", () => {
    expect(formatInstructions([], "/base")).toBe("");
  });

  it("inlines file content under a file tag named by its absolute path", () => {
    const dir = tempDir("instr-");
    const file = join(dir, "rules.md");
    writeFileSync(file, "# Rules\n\n- do the thing\n\n");

    const block = formatInstructions(["rules.md"], dir);
    expect(block).toContain("Project instructions");
    expect(block).toContain(`<file name="${file}">\n# Rules\n\n- do the thing\n</file>`);
  });

  it("reports a missing file in place instead of skipping it", () => {
    const dir = tempDir("instr-");
    const block = formatInstructions(["gone.md"], dir);
    expect(block).toContain(`<file name="${join(dir, "gone.md")}">\n${MISSING_INSTRUCTION}\n</file>`);
  });

  it("treats an empty file as missing, since the agent would follow nothing", () => {
    const dir = tempDir("instr-");
    writeFileSync(join(dir, "empty.md"), "\n\n");
    expect(formatInstructions(["empty.md"], dir)).toContain(MISSING_INSTRUCTION);
  });

  it("keeps declaration order across several files", () => {
    const dir = tempDir("instr-");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.md"), "AAA");
    writeFileSync(join(dir, "sub", "b.md"), "BBB");

    const block = formatInstructions(["a.md", "sub/b.md"], dir);
    expect(block.indexOf("AAA")).toBeLessThan(block.indexOf("BBB"));
  });
});

describe("projectInstructions", () => {
  it("selects the audience's entries and renders them", () => {
    const dir = tempDir("instr-");
    writeFileSync(join(dir, "main.md"), "MAIN");
    writeFileSync(join(dir, "child.md"), "CHILD");

    const entries = ["main.md", { path: "child.md", subagents: true }];
    const main = projectInstructions(entries, "main", dir);
    expect(main).toContain("MAIN");
    expect(main).toContain("CHILD");

    const child = projectInstructions(entries, "subagent", dir);
    expect(child).not.toContain("MAIN");
    expect(child).toContain("CHILD");
  });
});
