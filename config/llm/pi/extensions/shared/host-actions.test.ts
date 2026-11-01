import { describe, expect, test } from "bun:test";
import {
  copyCommands,
  copyText,
  type HostSpawner,
  openFolder,
  openFolderCommand,
  spawnHostCommand,
} from "./host-actions";

interface Call {
  command: string;
  args: string[];
  stdin?: string;
}

/** A spawner that answers per command name, so a test names the environment it imitates. */
function fakeSpawn(answers: Record<string, { code: number | null; error?: string }>): {
  calls: Call[];
  spawn: HostSpawner;
} {
  const calls: Call[] = [];
  return {
    calls,
    spawn: async (command, args, stdin) => {
      calls.push({ command, args, ...(stdin === undefined ? {} : { stdin }) });
      return answers[command] ?? { code: null, error: "not found" };
    },
  };
}

describe("copyCommands", () => {
  test("one writer per platform, Wayland before X11", () => {
    expect(copyCommands("darwin")).toEqual([{ command: "pbcopy", args: [] }]);
    expect(copyCommands("win32")).toEqual([{ command: "clip", args: [] }]);
    expect(copyCommands("linux").map((c) => c.command)).toEqual(["wl-copy", "xclip"]);
    expect(copyCommands("aix")).toEqual([]);
  });
});

describe("copyText", () => {
  test("hands the text to the writer on stdin", async () => {
    const fake = fakeSpawn({ pbcopy: { code: 0 } });
    expect(await copyText("hello", { platform: "darwin", spawn: fake.spawn })).toEqual({ ok: true });
    expect(fake.calls).toEqual([{ command: "pbcopy", args: [], stdin: "hello" }]);
  });

  test("falls through to the next candidate when one is missing", async () => {
    const fake = fakeSpawn({ xclip: { code: 0 } });
    expect(await copyText("hi", { platform: "linux", spawn: fake.spawn })).toEqual({ ok: true });
    expect(fake.calls.map((c) => c.command)).toEqual(["wl-copy", "xclip"]);
    expect(fake.calls[1]?.args).toEqual(["-selection", "clipboard"]);
  });

  test("reports every failure when no candidate works", async () => {
    const fake = fakeSpawn({});
    const result = await copyText("hi", { platform: "linux", spawn: fake.spawn });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("wl-copy");
    expect(result.reason).toContain("xclip");
  });

  test("a non-zero exit counts as a failure", async () => {
    const fake = fakeSpawn({ pbcopy: { code: 1 } });
    expect((await copyText("hi", { platform: "darwin", spawn: fake.spawn })).ok).toBe(false);
  });

  test("an unknown platform says so instead of spawning nothing", async () => {
    const fake = fakeSpawn({});
    const result = await copyText("hi", { platform: "aix", spawn: fake.spawn });
    expect(result).toEqual({ ok: false, reason: "no clipboard command known for aix" });
    expect(fake.calls).toEqual([]);
  });
});

describe("spawnHostCommand", () => {
  test("a writer that exits before reading its stdin does not crash the caller", async () => {
    // A clipboard command with no display exits immediately, while the payload is larger than the pipe
    // buffer. Without a listener on the stream, that is an unhandled `EPIPE` thrown into pi's event loop.
    const result = await spawnHostCommand("/bin/sh", ["-c", "exit 1"], "x".repeat(200_000));
    expect(result).toEqual({ code: 1 });
  });

  test("a command that does not exist reports the spawn error", async () => {
    const result = await spawnHostCommand("/nonexistent/pi-test-command", []);
    expect(result.code).toBeNull();
    expect(result.error).toContain("ENOENT");
  });
});

describe("openFolder", () => {
  test("passes the directory to the platform's opener", async () => {
    const fake = fakeSpawn({ open: { code: 0 } });
    expect(await openFolder("/tmp/pi-jobs", { platform: "darwin", spawn: fake.spawn })).toEqual({ ok: true });
    expect(fake.calls).toEqual([{ command: "open", args: ["/tmp/pi-jobs"] }]);
  });

  test("uses the Windows and Linux openers", () => {
    expect(openFolderCommand("/tmp/x", "win32")).toEqual({ command: "explorer", args: ["/tmp/x"] });
    expect(openFolderCommand("/tmp/x", "linux")).toEqual({ command: "xdg-open", args: ["/tmp/x"] });
    expect(openFolderCommand("/tmp/x", "aix")).toBeUndefined();
  });

  test("reports the failure reason", async () => {
    const fake = fakeSpawn({ open: { code: null, error: "spawn open ENOENT" } });
    const result = await openFolder("/tmp/pi-jobs", { platform: "darwin", spawn: fake.spawn });
    expect(result).toEqual({ ok: false, reason: "open: spawn open ENOENT" });
  });
});
