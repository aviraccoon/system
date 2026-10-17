import { describe, expect, test } from "bun:test";
import { parseCounts, remoteConfigured, remoteName, syncArgs } from "./rclone";

describe("syncArgs", () => {
  const base = { src: "/home/me/dev", dest: "b2crypt:host/dev", filterFile: "/tmp/filter", logFile: "/tmp/log" };

  test("always passes the filter file and delete-excluded", () => {
    const args = syncArgs(base);
    expect(args.slice(0, 3)).toEqual(["sync", base.src, base.dest]);
    expect(args).toContain("--filter-from");
    expect(args).toContain("--delete-excluded");
    expect(args).not.toContain("--dry-run");
  });

  test("symlinks are stored, not dropped", () => {
    expect(syncArgs(base)).toContain("--links");
  });

  test("copy destinations do not delete", () => {
    expect(syncArgs({ ...base, mode: "copy" })).not.toContain("--delete-excluded");
    expect(syncArgs({ ...base, mode: "mirror" })).toContain("--delete-excluded");
  });

  test("a slice never deletes excluded files", () => {
    const args = syncArgs({ ...base, slice: true });
    expect(args).not.toContain("--delete-excluded");
    expect(args).toContain("--links");
  });

  test("extra flags pass through", () => {
    expect(syncArgs({ ...base, extraFlags: ["--size-only"] })).toContain("--size-only");
  });

  test("bandwidth limit and dry run are optional", () => {
    expect(syncArgs({ ...base, bwLimit: "63M" })).toContain("63M");
    expect(syncArgs({ ...base, dryRun: true })).toContain("--dry-run");
  });
});

describe("parseCounts", () => {
  test("counts only rclone's per-file messages", () => {
    const log = [
      "2026/10/17 13:00:00 INFO  : keep/file.txt: Copied (new)",
      "2026/10/17 13:00:01 INFO  : keep/file.txt: Copied (replaced existing)",
      "2026/10/17 13:00:02 INFO  : junk.bin: Deleted",
      "2026/10/17 13:00:02 INFO  : Deleted:                2 (files), 1 (dirs), 36 B (freed)",
      "2026/10/17 13:00:02 INFO  : something: Copied (new)",
      "raccache: 3 new, 1 changed, 2 deleted",
      "2026/10/17 13:00:03 INFO  : foo/Copied (new): renamed",
    ];
    expect(parseCounts(log)).toEqual({ copied: 2, changed: 1, deleted: 1 });
  });

  test("rclone's summary lines and renamed files do not count", () => {
    expect(
      parseCounts([
        "2026/10/17 13:00:02 INFO  : Deleted:                2 (files), 1 (dirs), 36 B (freed)",
        "2026/10/17 13:00:02 INFO  : Transferred:            1 / 1, 100%",
        "2026/10/17 13:00:03 INFO  : new-files/Copied (new): renamed",
      ]),
    ).toEqual({ copied: 0, changed: 0, deleted: 0 });
  });
});

describe("remote helpers", () => {
  test("remote name comes from the destination prefix", () => {
    expect(remoteName("b2crypt:host/dev")).toBe("b2crypt");
    expect(remoteName("/local/path")).toBe("");
  });

  test("configured remotes are checked with the trailing colon", () => {
    expect(remoteConfigured(["b2crypt:", "other:"], "b2crypt:host/dev")).toBe(true);
    expect(remoteConfigured(["b2crypt-other:"], "b2crypt:host/dev")).toBe(false);
    expect(remoteConfigured(["b2crypt:"], "/local/path")).toBe(false);
  });
});
