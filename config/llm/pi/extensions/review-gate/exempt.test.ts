import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExempt, loadExemptions, removeExemption, setExemption } from "./exempt";

const dirs: string[] = [];

function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-exempt-"));
  dirs.push(dir);
  return join(dir, "exempt.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("repository exemptions", () => {
  test("a missing file exempts nothing", () => {
    expect(isExempt(loadExemptions(path()), "/tmp/example")).toBe(false);
  });

  test("a malformed file exempts nothing rather than everything", () => {
    const file = path();
    writeFileSync(file, "{oops");
    expect(loadExemptions(file).repos).toEqual([]);
  });

  test("an exemption is per repository and can be removed", () => {
    const file = path();
    setExemption(file, { repo: "/tmp/a", at: "2026-10-23T12:00:00.000Z" });
    expect(isExempt(loadExemptions(file), "/tmp/a")).toBe(true);
    expect(isExempt(loadExemptions(file), "/tmp/b")).toBe(false);
    removeExemption(file, "/tmp/a");
    expect(isExempt(loadExemptions(file), "/tmp/a")).toBe(false);
  });

  test("setting the same repository twice keeps one entry", () => {
    const file = path();
    setExemption(file, { repo: "/tmp/a", at: "2026-10-23T12:00:00.000Z" });
    setExemption(file, { repo: "/tmp/a", at: "2026-10-23T12:01:00.000Z", sessionId: "s" });
    const repos = loadExemptions(file).repos;
    expect(repos).toHaveLength(1);
    expect(repos[0]?.sessionId).toBe("s");
  });
});
