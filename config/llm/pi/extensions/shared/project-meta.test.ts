import { describe, expect, it } from "bun:test";
import { formatMetaProblems, harvestEnabled, instructionsFor, parseProjectMeta } from "./project-meta";

const PATH = "/notes/llm/acme/meta.json";

function parse(raw: Record<string, unknown>) {
  return parseProjectMeta(raw, PATH);
}

describe("parseProjectMeta", () => {
  it("reads a clean file with every field and reports nothing", () => {
    const { meta, problems } = parse({
      description: "d",
      path: "~/code/acme",
      harvest: { note: "alias acme" },
      instructions: ["a.md", { path: "b.md", subagents: true }],
    });

    expect(problems).toEqual([]);
    expect(meta).toEqual({
      description: "d",
      path: "~/code/acme",
      harvest: { note: "alias acme" },
      instructions: [
        { path: "a.md", subagents: false },
        { path: "b.md", subagents: true },
      ],
    });
  });

  it("normalizes the harvest flag to an object only when it is on", () => {
    expect(parse({ harvest: true }).meta.harvest).toEqual({});
    expect(parse({ harvest: { note: "  spaced  " } }).meta.harvest).toEqual({ note: "spaced" });
    expect(parse({ harvest: { note: "   " } }).meta.harvest).toEqual({});
  });

  it("treats false and an absent flag as off, with no problem", () => {
    expect(parse({ harvest: false })).toEqual({ meta: { instructions: [] }, problems: [] });
    expect(parse({})).toEqual({ meta: { instructions: [] }, problems: [] });
  });

  it("keeps one entry per path, in declaration order", () => {
    const { meta, problems } = parse({ instructions: ["a.md", "b.md", "a.md"] });
    expect(problems).toEqual([]);
    expect(meta.instructions.map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
  });

  it("merges a repeated path into the widest audience", () => {
    const { meta, problems } = parse({ instructions: ["b.md", { path: "b.md", subagents: true }] });
    expect(problems).toEqual([]);
    expect(meta.instructions).toEqual([{ path: "b.md", subagents: true }]);
    expect(instructionsFor(meta, "subagent").map((entry) => entry.path)).toEqual(["b.md"]);
  });

  // One row per way a hand-edit can be wrong. A new field earns a row here before
  // it earns a branch anywhere else.
  const broken: Array<{ name: string; raw: Record<string, unknown>; problem: string }> = [
    { name: "a non-string description", raw: { description: 5 }, problem: "`description`" },
    { name: "a non-string path", raw: { path: 5 }, problem: "`path`" },
    { name: "a null harvest flag", raw: { harvest: null }, problem: "`harvest`" },
    { name: "a string harvest flag", raw: { harvest: "yes" }, problem: "`harvest`" },
    { name: "an array harvest flag", raw: { harvest: [] }, problem: "`harvest`" },
    { name: "a non-string harvest note", raw: { harvest: { note: 5 } }, problem: "`harvest.note`" },
    { name: "a non-array instructions value", raw: { instructions: "a.md" }, problem: "`instructions`" },
    {
      name: "an entry with the wrong key",
      raw: { instructions: [{ file: "a.md" }] },
      problem: "entry 1 of `instructions`",
    },
    { name: "an entry that is a number", raw: { instructions: [7] }, problem: "entry 1 of `instructions`" },
    { name: "an entry with a blank path", raw: { instructions: ["   "] }, problem: "entry 1 of `instructions`" },
    {
      name: "a non-boolean subagents marker",
      raw: { instructions: [{ path: "a.md", subagents: "true" }] },
      problem: "`subagents`",
    },
    { name: "a misspelled top-level key", raw: { instruction: ["a.md"] }, problem: "unknown key `instruction`" },
    {
      name: "a misspelled entry key",
      raw: { instructions: [{ path: "a.md", subagent: true }] },
      problem: "unknown key `subagent`",
    },
    { name: "a misspelled harvest key", raw: { harvest: { notes: "x" } }, problem: "`notes` in `harvest`" },
  ];

  for (const row of broken) {
    it(`reports ${row.name}`, () => {
      const { problems } = parse(row.raw);
      const named = problems.filter((problem) => problem.includes(row.problem));
      expect(named.length).toBeGreaterThan(0);
      for (const problem of problems) {
        expect(problem).toContain(PATH);
        expect(problem).toMatch(/—/);
      }
    });
  }

  it("keeps an entry whose key is merely misspelled, and says which key", () => {
    const { meta, problems } = parse({ instructions: [{ path: "a.md", subagent: true }] });
    expect(meta.instructions).toEqual([{ path: "a.md", subagents: false }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unknown key `subagent`");
  });

  it("reports a misspelled top-level key instead of dropping the field it meant", () => {
    const { meta, problems } = parse({ instruction: ["a.md"] });
    expect(meta.instructions).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("unknown key `instruction`");
  });

  it("keeps the harvest flag on when its note key is misspelled, and says so", () => {
    const { meta, problems } = parse({ harvest: { notes: "alias acme" } });
    expect(meta.harvest).toEqual({});
    expect(harvestEnabled(meta)).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("`notes` in `harvest`");
  });

  it("keeps what still reads when one field is broken", () => {
    const { meta, problems } = parse({
      harvest: { note: 5 },
      instructions: ["a.md", { path: "b.md", subagents: "yes" }, "c.md"],
    });
    expect(meta.harvest).toEqual({});
    expect(meta.instructions.map((entry) => entry.path)).toEqual(["a.md", "c.md"]);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain("entry 2 of `instructions`");
  });
});

describe("harvestEnabled", () => {
  it("follows the normalized flag", () => {
    expect(harvestEnabled(parse({ harvest: true }).meta)).toBe(true);
    expect(harvestEnabled(parse({ harvest: { note: "x" } }).meta)).toBe(true);
    expect(harvestEnabled(parse({ harvest: false }).meta)).toBe(false);
    expect(harvestEnabled(parse({}).meta)).toBe(false);
    expect(harvestEnabled(parse({ harvest: null }).meta)).toBe(false);
  });
});

describe("instructionsFor", () => {
  it("loads everything for the main agent and the marked entries for children", () => {
    const { meta } = parse({ instructions: ["a.md", { path: "b.md", subagents: true }] });
    expect(instructionsFor(meta, "main").map((entry) => entry.path)).toEqual(["a.md", "b.md"]);
    expect(instructionsFor(meta, "subagent").map((entry) => entry.path)).toEqual(["b.md"]);
  });
});

describe("formatMetaProblems", () => {
  it("is empty when the file is clean", () => {
    expect(formatMetaProblems([])).toBe("");
  });

  it("renders one bullet per problem under a header", () => {
    const lines = formatMetaProblems(["one", "two"]).split("\n");
    expect(lines[0]).toContain("Project settings problems");
    expect(lines.slice(1)).toEqual(["- one", "- two"]);
  });
});
