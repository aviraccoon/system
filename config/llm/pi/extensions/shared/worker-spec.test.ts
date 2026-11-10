import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKER_SHELL, isWorkerShell, workerSpecFields } from "./worker-spec";

describe("workerSpecFields", () => {
  test("defaults the shell and keeps the instructions", () => {
    expect(workerSpecFields({ instructions: "check it" })).toEqual({ instructions: "check it", bash: "sandboxed" });
  });

  test("a named shell wins", () => {
    expect(workerSpecFields({ instructions: "x", bash: "normal" }).bash).toBe("normal");
  });

  test("an unknown shell falls back to the default", () => {
    expect(workerSpecFields({ bash: "readonly" }).bash).toBe(DEFAULT_WORKER_SHELL);
  });

  test("a non-object spec yields the defaults", () => {
    for (const spec of [undefined, null, "x", ["x"], 42]) {
      expect(workerSpecFields(spec)).toEqual({ instructions: "", bash: DEFAULT_WORKER_SHELL });
    }
  });

  test("the default is a shell the validator accepts", () => {
    expect(isWorkerShell(DEFAULT_WORKER_SHELL)).toBe(true);
    expect(isWorkerShell("readonly")).toBe(false);
  });
});
