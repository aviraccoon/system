import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acquireLock, releaseLock } from "./lock";

let dir = "";

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "raccache-lock-")), "lock");
});

afterEach(() => {
  rmSync(dirname(dir), { recursive: true, force: true });
});

describe("acquireLock", () => {
  test("takes the lock and records the pid", () => {
    const result = acquireLock(dir, { pid: 1234 });
    expect(result.acquired).toBe(true);
    expect(readFileSync(join(dir, "pid"), "utf8").trim()).toBe("1234");
  });

  test("a reload can take a released lock again", () => {
    expect(acquireLock(dir, { pid: 1 }).acquired).toBe(true);
    releaseLock(dir);
    expect(acquireLock(dir, { pid: 2 }).acquired).toBe(true);
  });

  test("a live holder is refused with its pid", () => {
    acquireLock(dir, { pid: 4242 });
    const second = acquireLock(dir, { pid: 4243, isAlive: () => true });
    expect(second.acquired).toBe(false);
    expect(second.reason).toContain("4242");
  });

  test("a dead holder is reclaimed", () => {
    acquireLock(dir, { pid: 4242 });
    const second = acquireLock(dir, { pid: 4243, isAlive: () => false });
    expect(second.acquired).toBe(true);
    expect(readFileSync(join(dir, "pid"), "utf8").trim()).toBe("4243");
  });

  test("a pid-less lock counts as live while young", () => {
    acquireLock(dir, { pid: 1 });
    rmSync(join(dir, "pid"));
    const second = acquireLock(dir, { pid: 2, now: () => Date.now() });
    expect(second.acquired).toBe(false);
    expect(second.reason).toContain("unknown");
  });

  test("a pid-less lock is reclaimed once old", () => {
    acquireLock(dir, { pid: 1 });
    rmSync(join(dir, "pid"));
    const past = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(dir, past, past);
    const second = acquireLock(dir, { pid: 2, now: () => Date.now() });
    expect(second.acquired).toBe(true);
  });

  test("reclaim leaves no stale directory behind", () => {
    acquireLock(dir, { pid: 4242 });
    acquireLock(dir, { pid: 4243, isAlive: () => false });
    expect(existsSync(`${dir}.stale.4243`)).toBe(false);
  });
});

describe("releaseLock", () => {
  test("releasing a missing lock is a no-op", () => {
    releaseLock(join(dir, "missing"));
    releaseLock(dir);
  });
});
