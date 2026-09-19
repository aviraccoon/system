import { describe, expect, test } from "bun:test";
import { resolveMode } from "./mode";

describe("resolveMode", () => {
  test("a one-item tasks batch resolves to single", () => {
    expect(resolveMode({ tasks: [{ agent: "reviewer", task: "review the change" }] })).toEqual({
      parallelTasks: undefined,
      singleAgent: "reviewer",
      singleTask: "review the change",
      singleCwd: undefined,
    });
  });

  test("a collapsed item keeps its cwd", () => {
    expect(resolveMode({ tasks: [{ agent: "reviewer", task: "go", cwd: "/tmp" }] }).singleCwd).toBe("/tmp");
  });

  test("a collapsed item does not inherit the top-level cwd", () => {
    expect(resolveMode({ tasks: [{ agent: "reviewer", task: "go" }], cwd: "/elsewhere" }).singleCwd).toBeUndefined();
  });

  test("a top-level cwd applies to an explicit single call", () => {
    expect(resolveMode({ agent: "editor", task: "trim", cwd: "/tmp" }).singleCwd).toBe("/tmp");
  });

  test("two items stay parallel", () => {
    const { parallelTasks, singleAgent } = resolveMode({
      tasks: [
        { agent: "a", task: "x" },
        { agent: "b", task: "y" },
      ],
    });
    expect(parallelTasks).toHaveLength(2);
    expect(singleAgent).toBeUndefined();
  });

  test("an explicit single call does not collapse the batch (invalid combination)", () => {
    const { parallelTasks, singleAgent } = resolveMode({
      agent: "editor",
      task: "trim",
      tasks: [{ agent: "a", task: "x" }],
    });
    expect(parallelTasks).toEqual([{ agent: "a", task: "x" }]);
    expect(singleAgent).toBe("editor");
  });

  test("a chain does not collapse the batch (invalid combination)", () => {
    const { parallelTasks } = resolveMode({
      chain: [{ agent: "a", task: "x" }],
      tasks: [{ agent: "b", task: "y" }],
    });
    expect(parallelTasks).toEqual([{ agent: "b", task: "y" }]);
  });

  test("an empty tasks array is not a mode", () => {
    const { parallelTasks, singleAgent } = resolveMode({ tasks: [] });
    expect(parallelTasks).toEqual([]);
    expect(singleAgent).toBeUndefined();
  });

  test("an item with an empty agent or task is not collapsed", () => {
    const { parallelTasks, singleAgent } = resolveMode({ tasks: [{ agent: "a", task: "" }] });
    expect(parallelTasks).toHaveLength(1);
    expect(singleAgent).toBeUndefined();
    const emptyAgent = resolveMode({ tasks: [{ agent: "", task: "x" }] });
    expect(emptyAgent.parallelTasks).toHaveLength(1);
    expect(emptyAgent.singleAgent).toBeUndefined();
  });
});
