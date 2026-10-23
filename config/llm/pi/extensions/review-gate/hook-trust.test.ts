import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashHook, isHookTrusted, loadHookTrust, trustHook } from "./hook-trust";

const dirs: string[] = [];

function path(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-gate-trust-"));
  dirs.push(dir);
  return join(dir, "trust.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HASH = hashHook("#!/bin/sh\necho hi\n");
const OTHER = hashHook("#!/bin/sh\necho changed\n");

describe("repository hook trust", () => {
  test("a missing or malformed file trusts nothing", () => {
    const file = path();
    expect(isHookTrusted(loadHookTrust(file), "/tmp/a", "pre-commit", HASH)).toBe(false);
    writeFileSync(file, "not json");
    expect(isHookTrusted(loadHookTrust(file), "/tmp/a", "pre-commit", HASH)).toBe(false);
  });

  test("trust is keyed by repository, hook name and content hash", () => {
    const file = path();
    trustHook(file, { repo: "/tmp/a", hook: "pre-commit", sha256: HASH, at: "2026-10-23T12:00:00.000Z" });
    const trust = loadHookTrust(file);
    expect(isHookTrusted(trust, "/tmp/a", "pre-commit", HASH)).toBe(true);
    expect(isHookTrusted(trust, "/tmp/b", "pre-commit", HASH)).toBe(false);
    expect(isHookTrusted(trust, "/tmp/a", "commit-msg", HASH)).toBe(false);
  });

  test("changed content no longer matches", () => {
    const file = path();
    trustHook(file, { repo: "/tmp/a", hook: "pre-commit", sha256: HASH, at: "2026-10-23T12:00:00.000Z" });
    expect(isHookTrusted(loadHookTrust(file), "/tmp/a", "pre-commit", OTHER)).toBe(false);
  });

  test("re-trusting one hook replaces its hash and keeps the others", () => {
    const file = path();
    trustHook(file, { repo: "/tmp/a", hook: "pre-commit", sha256: HASH, at: "2026-10-23T12:00:00.000Z" });
    trustHook(file, { repo: "/tmp/a", hook: "commit-msg", sha256: HASH, at: "2026-10-23T12:00:00.000Z" });
    trustHook(file, { repo: "/tmp/a", hook: "pre-commit", sha256: OTHER, at: "2026-10-23T12:01:00.000Z" });
    const trust = loadHookTrust(file);
    expect(trust.hooks).toHaveLength(2);
    expect(isHookTrusted(trust, "/tmp/a", "pre-commit", OTHER)).toBe(true);
    expect(isHookTrusted(trust, "/tmp/a", "pre-commit", HASH)).toBe(false);
    expect(isHookTrusted(trust, "/tmp/a", "commit-msg", HASH)).toBe(true);
  });
});
