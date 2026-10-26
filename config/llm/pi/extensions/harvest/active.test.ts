import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestActive } from "./active";

describe("harvestActive", () => {
  /** A notes tree with one project dir carrying `meta`. */
  function notesTree(meta: unknown): string {
    const notesDir = mkdtempSync(join(tmpdir(), "harvest-"));
    mkdirSync(join(notesDir, "acme"));
    writeFileSync(join(notesDir, "acme", "meta.json"), JSON.stringify(meta));
    return notesDir;
  }

  it("is active for a flagged project", async () => {
    expect(await harvestActive(notesTree({ harvest: true }), "/code/acme")).toBe(true);
  });

  it("is active for the object form", async () => {
    expect(await harvestActive(notesTree({ harvest: { note: "alias acme" } }), "/code/acme")).toBe(true);
  });

  it("is off for a project without the flag", async () => {
    expect(await harvestActive(notesTree({ description: "d" }), "/code/acme")).toBe(false);
  });

  it("is off when the flag is null, so the pill and the injected policy agree", async () => {
    expect(await harvestActive(notesTree({ harvest: null }), "/code/acme")).toBe(false);
  });

  it("is active for an object flag whose note is not a string", async () => {
    expect(await harvestActive(notesTree({ harvest: { note: 5 } }), "/code/acme")).toBe(true);
  });

  it("is off when the project has no meta.json", async () => {
    const notesDir = mkdtempSync(join(tmpdir(), "harvest-"));
    expect(await harvestActive(notesDir, "/code/unknown")).toBe(false);
  });

  it("follows a worktree session to its checkout's flag", async () => {
    const notesDir = notesTree({ harvest: true });
    expect(await harvestActive(notesDir, "/code/acme.worktrees/feat/x")).toBe(true);
    expect(await harvestActive(notesDir, "/code/acme/.worktrees/x")).toBe(true);
  });
});
