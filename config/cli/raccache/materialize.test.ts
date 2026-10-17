import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadlockPaths, materialize, readable } from "./materialize";

/** A line as rclone writes it for a cloud-only file. */
const deadlockLine = (path: string): string =>
  `2026/10/17 13:27:38 ERROR : note.pdf: Failed to copy: Post "https://example.invalid/upload": read ${path}: resource deadlock avoided`;

const tempDir = (): string => mkdtempSync(join(tmpdir(), "raccache-materialize-"));

test("names come out of rclone's log, deduped, and only for files that are there", () => {
  const dir = tempDir();
  const file = join(dir, "note.pdf");
  writeFileSync(file, "x");
  const lines = [deadlockLine(file), deadlockLine(file)];
  expect(deadlockPaths(lines)).toEqual([file]);
  expect(deadlockPaths([deadlockLine(join(dir, "gone.pdf"))])).toEqual([]);
  expect(deadlockPaths(["2026/10/17 13:27:38 ERROR : other: Failed to copy: connection reset by peer"])).toEqual([]);
  expect(deadlockPaths([deadlockLine(dir)])).toEqual([]); // a directory is not a source file
});

test("readable is true for a local file, false for a path that is not there", () => {
  const dir = tempDir();
  const empty = join(dir, "empty");
  writeFileSync(empty, "");
  expect(readable(empty)).toBe(true);
  expect(readable(join(dir, "missing"))).toBe(false);
});

test("an unreadable file is requested from the daemon and polled until it reads", async () => {
  const dir = tempDir();
  const brctlLog = join(dir, "brctl.args");
  const brctl = join(dir, "brctl");
  writeFileSync(brctl, `#!/bin/sh\necho "$@" >> "${brctlLog}"\n`);
  chmodSync(brctl, 0o755);
  const target = join(dir, "note.pdf");
  writeFileSync(target, "x");

  let attempts = 0;
  const result = await materialize([target], {
    brctl,
    intervalMs: 0,
    deadlineMs: 5,
    isReadable: () => ++attempts > 2,
    now: () => 0,
    sleep: async () => {},
  });

  expect(result).toEqual({ requested: 1, fetched: 1, pending: [] });
  expect(readFileSync(brctlLog, "utf8")).toBe(`download ${target}\n`);
});

test("a file already local is not requested", async () => {
  const dir = tempDir();
  const brctlLog = join(dir, "brctl.args");
  const brctl = join(dir, "brctl");
  writeFileSync(brctl, `#!/bin/sh\necho "$@" >> "${brctlLog}"\n`);
  chmodSync(brctl, 0o755);

  const result = await materialize([join(dir, "local.pdf")], {
    brctl,
    isReadable: () => true,
    now: () => 0,
    sleep: async () => {},
  });

  expect(result).toEqual({ requested: 0, fetched: 0, pending: [] });
  expect(existsSync(brctlLog)).toBe(false);
});

test("what the daemon never fetches is reported instead of waited on forever", async () => {
  const dir = tempDir();
  const brctl = join(dir, "brctl");
  writeFileSync(brctl, "#!/bin/sh\nexit 0\n");
  chmodSync(brctl, 0o755);
  const stuck = join(dir, "stuck.pdf");
  writeFileSync(stuck, "x");

  let clock = 0;
  const result = await materialize([stuck], {
    brctl,
    intervalMs: 0,
    deadlineMs: 3,
    isReadable: () => false,
    now: () => (clock += 2),
    sleep: async () => {},
  });

  expect(result).toEqual({ requested: 1, fetched: 0, pending: [stuck] });
});

test("a path deleted since the failed read is not cloud-only", async () => {
  const dir = tempDir();
  const brctl = join(dir, "brctl");
  writeFileSync(brctl, "#!/bin/sh\nexit 0\n");
  chmodSync(brctl, 0o755);

  let clock = 0;
  const result = await materialize([join(dir, "vanished.pdf")], {
    brctl,
    intervalMs: 0,
    deadlineMs: 10,
    isReadable: () => false,
    now: () => (clock += 1),
    sleep: async () => {},
  });

  expect(result).toEqual({ requested: 0, fetched: 0, pending: [] });
});
