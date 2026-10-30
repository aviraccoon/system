import { describe, expect, test } from "bun:test";
import { parsePolicyFile } from "./policy-file";

const VALID = {
  project: "acme-widgets",
  environment: "the devcontainer",
  binding: {
    command: "docker exec -w /workspaces/acme-widgets/app acme-dev-1",
    workdir: "/workspaces/acme-widgets/app",
  },
  clauses: [
    { id: "deps", text: "Dependency work runs in the devcontainer." },
    { id: "e2e", text: "Browser suites run on the host." },
  ],
  precedence: "The e2e clause is the only exception.",
};

const json = (value: unknown) => JSON.stringify(value);

describe("parsePolicyFile", () => {
  test("accepts a complete file and keeps every field", () => {
    const { policy, errors } = parsePolicyFile(json(VALID));
    expect(errors).toEqual([]);
    expect(policy).toEqual(VALID);
  });

  test("a file without a binding or precedence is valid, with both absent", () => {
    const { project, environment, clauses } = VALID;
    const { policy, errors } = parsePolicyFile(json({ project, environment, clauses }));
    expect(errors).toEqual([]);
    expect(policy?.binding).toBeNull();
    expect(policy?.precedence).toBeUndefined();
  });

  test("trims padded strings instead of storing them padded", () => {
    const { policy } = parsePolicyFile(json({ ...VALID, project: "  acme-widgets  " }));
    expect(policy?.project).toBe("acme-widgets");
  });

  // One row per way a hand-edited file goes wrong. Each must name the problem and
  // deactivate the guard, never run on a partial policy.
  const broken: [string, unknown, string][] = [
    ["not JSON", undefined, "not valid JSON"],
    ["a top-level array", [], "must be a JSON object"],
    ["a missing project", { ...VALID, project: undefined }, '"project" must be a non-empty string'],
    ["a blank environment", { ...VALID, environment: "   " }, '"environment" must be a non-empty string'],
    ["no clauses", { ...VALID, clauses: [] }, '"clauses" must be a non-empty array'],
    ["clauses not an array", { ...VALID, clauses: "deps" }, '"clauses" must be a non-empty array'],
    ["a clause that is not an object", { ...VALID, clauses: ["deps"] }, "clauses[0] must be an object"],
    ["a clause without text", { ...VALID, clauses: [{ id: "deps" }] }, "clauses[0].text must be a non-empty string"],
    [
      "duplicate clause ids",
      {
        ...VALID,
        clauses: [
          { id: "deps", text: "a" },
          { id: "deps", text: "b" },
        ],
      },
      'clauses[1].id "deps" is a duplicate',
    ],
    [
      "a binding without a workdir",
      { ...VALID, binding: { command: "docker exec c" } },
      '"binding.workdir" must be a non-empty string',
    ],
    ["a binding that is not an object", { ...VALID, binding: "docker exec c" }, '"binding" must be an object or null'],
    ["a blank precedence", { ...VALID, precedence: " " }, '"precedence" must be a non-empty string when present'],
    ["an unknown top-level key", { ...VALID, clauses_note: "typo" }, 'unknown key "clauses_note"'],
    [
      "an unknown clause key",
      { ...VALID, clauses: [{ id: "deps", text: "a", exceptions: [] }] },
      'clauses[0]: unknown key "exceptions"',
    ],
  ];

  for (const [name, value, expected] of broken) {
    test(`${name} is reported and leaves no policy`, () => {
      const raw = value === undefined ? "{ project: acme-widgets }" : json(value);
      const { policy, errors } = parsePolicyFile(raw);
      expect(policy).toBeNull();
      expect(errors.join("\n")).toContain(expected);
    });
  }

  test("every problem is reported, not just the first", () => {
    const { errors } = parsePolicyFile(json({ project: "", environment: "", clauses: [] }));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
