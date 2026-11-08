/**
 * The marker directory that lets one extension see another's background work.
 *
 * Every case runs against a temp directory, so the suite never writes into this
 * machine's `$TMPDIR` job area or reads a marker a real session left there.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listPending, markPending, pendingWorkDir } from "./pending-work";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-work-"));
  env = { TMPDIR: root, PI_PENDING_WORK_DIR: path.join(root, "markers") };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pending work", () => {
  test("a marker is announced and removed by its release", () => {
    const release = markPending("session-1", { kind: "job", id: "j-1" }, env);
    expect(listPending("session-1", env).map((item) => item.id)).toEqual(["j-1"]);
    release();
    expect(listPending("session-1", env)).toEqual([]);
  });

  test("sessions do not see each other's work", () => {
    const release = markPending("session-1", { kind: "job", id: "j-1" }, env);
    expect(listPending("session-2", env)).toEqual([]);
    release();
  });

  test("counts add up across producers, newest first", () => {
    const now = Date.now();
    const releaseJob = markPending("s", { kind: "job", id: "j-1", startedAt: now - 2_000 }, env);
    const releaseSubagent = markPending("s", { kind: "subagent", id: "a-1", startedAt: now - 1_000 }, env);
    expect(listPending("s", env).map((item) => item.kind)).toEqual(["subagent", "job"]);
    releaseJob();
    expect(listPending("s", env).map((item) => item.id)).toEqual(["a-1"]);
    releaseSubagent();
  });

  test("an id that is not a plain filename stays inside the session directory", () => {
    const release = markPending("s", { kind: "job", id: "../../escape" }, env);
    const files = fs.readdirSync(path.join(pendingWorkDir(env), "s"));
    expect(files).toEqual([".._.._escape.json"]);
    expect(listPending("s", env).map((item) => item.id)).toEqual(["../../escape"]);
    release();
  });

  test("a session id that is not a plain directory name stays inside the markers directory", () => {
    // Unparseable, beside the markers directory: the reader deletes what it cannot parse, so this file
    // is what an escaping `..` would eat.
    const beside = path.join(path.dirname(pendingWorkDir(env)), "keep.json");
    fs.mkdirSync(path.dirname(beside), { recursive: true });
    fs.writeFileSync(beside, "{not json");

    const release = markPending("..", { kind: "job", id: "j-1" }, env);
    expect(listPending("..", env).map((item) => item.id)).toEqual(["j-1"]);
    expect(fs.existsSync(beside)).toBe(true);
    expect(fs.readdirSync(path.join(pendingWorkDir(env), "__"))).toEqual(["j-1.json"]);
    release();
  });

  test("an unreadable marker is skipped and deleted", () => {
    const dir = path.join(pendingWorkDir(env), "s");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
    fs.writeFileSync(path.join(dir, "not-pending.json"), JSON.stringify({ kind: "job" }));
    expect(listPending("s", env)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("a marker past the age bound stops counting", () => {
    const old = Date.now() - 25 * 60 * 60 * 1000;
    markPending("s", { kind: "job", id: "j-old", startedAt: old }, env);
    const release = markPending("s", { kind: "job", id: "j-new" }, env);
    expect(listPending("s", env).map((item) => item.id)).toEqual(["j-new"]);
    // The reader deletes what it skips, so a dead marker is not re-read on every later settle.
    expect(fs.readdirSync(path.join(pendingWorkDir(env), "s"))).toEqual(["j-new.json"]);
    release();
  });

  test("no directory yet is no work, not an error", () => {
    expect(listPending("never-used", env)).toEqual([]);
  });

  test("without an override the markers live in the temp directory", () => {
    expect(pendingWorkDir({ TMPDIR: root })).toBe(path.join(root, "pi-pending-work"));
  });

  test("a staging file is not a marker", () => {
    const dir = path.join(pendingWorkDir(env), "s");
    fs.mkdirSync(dir, { recursive: true });
    // What a write that died before its rename leaves behind; the write itself renames into place.
    fs.writeFileSync(path.join(dir, "j-1.json.tmp"), JSON.stringify({ kind: "job", id: "j-1", startedAt: Date.now() }));
    expect(listPending("s", env)).toEqual([]);
  });

  test("a release run twice, and a marker directory that cannot be written, are both silent", () => {
    const release = markPending("s", { kind: "job", id: "j-1" }, env);
    release();
    expect(release).not.toThrow();
    // A path that cannot be created stands in for a read-only temp area.
    const blocked = { PI_PENDING_WORK_DIR: path.join(root, "file.txt", "markers") };
    fs.writeFileSync(path.join(root, "file.txt"), "");
    const releaseBlocked = markPending("s", { kind: "job", id: "j-2" }, blocked);
    expect(listPending("s", blocked)).toEqual([]);
    expect(releaseBlocked).not.toThrow();
  });
});
