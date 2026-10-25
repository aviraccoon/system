import { describe, expect, test } from "bun:test";
import { resolveResultNote } from "./result-notes";

describe("resolveResultNote", () => {
  test("a staged note and an in-flight one are joined", async () => {
    expect(await resolveResultNote(["patch advice"], Promise.resolve("test advice"), 50)).toBe(
      "patch advice\n\ntest advice",
    );
  });

  test("the same note from both sources appears once", async () => {
    expect(await resolveResultNote(["patch advice"], Promise.resolve("patch advice"), 50)).toBe("patch advice");
  });

  test("staged notes alone are the note", async () => {
    expect(await resolveResultNote(["patch advice"], undefined)).toBe("patch advice");
    expect(await resolveResultNote(["one", "two"], undefined)).toBe("one\n\ntwo");
  });

  test("an in-flight note that lands in time is used", async () => {
    expect(await resolveResultNote(undefined, Promise.resolve("patch advice"), 50)).toBe("patch advice");
  });

  test("an in-flight note that misses the wait yields only the staged text", async () => {
    const never = new Promise<string | undefined>(() => {});
    expect(await resolveResultNote(undefined, never, 5)).toBeUndefined();
    expect(await resolveResultNote(["staged"], never, 5)).toBe("staged");
  });

  test("nothing staged, nothing in flight", async () => {
    expect(await resolveResultNote(undefined, undefined)).toBeUndefined();
    expect(await resolveResultNote([], undefined)).toBeUndefined();
  });
});
