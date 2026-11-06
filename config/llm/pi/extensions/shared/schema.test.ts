import { describe, expect, test } from "bun:test";
import { type Static, Type } from "typebox";
import { stringEnum } from "./schema";

/** The JSON that reaches the provider: a schema object with nothing type-level in it. */
function json(schema: unknown): unknown {
  return JSON.parse(JSON.stringify(schema));
}

describe("stringEnum", () => {
  test("emits a plain string enum, not anyOf/const", () => {
    expect(json(stringEnum(["list", "add"] as const))).toEqual({ type: "string", enum: ["list", "add"] });
  });

  test("carries description and default", () => {
    expect(json(stringEnum(["a", "b"] as const, { description: "which", default: "b" }))).toEqual({
      type: "string",
      enum: ["a", "b"],
      description: "which",
      default: "b",
    });
  });

  test("keeps the literal union through TypeBox's Static (the pin here is tsc's)", () => {
    const schema = Type.Object({ action: stringEnum(["list", "add"] as const) });
    const params: Static<typeof schema> = { action: "list" };
    expect(params.action).toBe("list");

    // @ts-expect-error a value outside the enum is a type error
    const wrong: Static<typeof schema> = { action: "remove" };
    void wrong;
  });
});
