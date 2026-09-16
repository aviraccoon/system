import { describe, expect, it } from "bun:test";
import { buildHarvestBlock, loadHarvestPolicy } from "./journal-context";

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

  it("true flag yields the policy only", () => {
    expect(buildHarvestBlock(policy, true)).toBe("POLICY");
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
