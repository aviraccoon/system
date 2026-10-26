import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  expandInstructionPath,
  formatInstructions,
  MISSING_INSTRUCTION,
  projectInstructions,
} from "./extra-instructions";
import type { ProjectMeta } from "./project-meta";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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

    const meta: ProjectMeta = {
      instructions: [
        { path: "main.md", subagents: false },
        { path: "child.md", subagents: true },
      ],
    };
    const main = projectInstructions(meta, "main", dir);
    expect(main).toContain("MAIN");
    expect(main).toContain("CHILD");

    const child = projectInstructions(meta, "subagent", dir);
    expect(child).not.toContain("MAIN");
    expect(child).toContain("CHILD");
  });
});
