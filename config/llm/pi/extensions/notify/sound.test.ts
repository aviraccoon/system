import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  CUE_VERSION,
  cue,
  cueDir,
  cueFileName,
  ensureCue,
  hz,
  makePlayer,
  makeWaiter,
  motif,
  playCue,
  playCueAndWait,
  renderWav,
  type SpawnProcess,
  soundEnabled,
  soundIdleSeconds,
  spawnPlayer,
} from "./sound";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "notify-sound-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("motif", () => {
  test("is fixed per project", () => {
    expect(motif("acme")).toEqual(motif("acme"));
  });

  test("differs across projects", () => {
    expect(motif("globex")).not.toEqual(motif("acme"));
    expect(motif("initech")).not.toEqual(motif("acme"));
  });

  test("stays inside three pentatonic octaves", () => {
    for (let i = 0; i < 200; i++) {
      for (const degree of motif(`project-${i}`)) {
        expect(Number.isInteger(degree)).toBe(true);
        expect(degree).toBeGreaterThanOrEqual(0);
        expect(degree).toBeLessThanOrEqual(14);
      }
    }
  });

  test("is five notes", () => {
    expect(motif("acme")).toHaveLength(5);
  });
});

describe("cue", () => {
  test("done is the motif as a resolving arpeggio", () => {
    const { notes, seconds } = cue("acme", "done");
    expect(seconds).toBe(0.62);
    expect(notes.map((note) => note.hz)).toEqual(motif("acme").map(hz));
    expect(notes.map((note) => note.at)).toEqual([0, 0.11, 0.22, 0.33, 0.44]);
    expect(notes.map((note) => note.decay)).toEqual([11, 11, 11, 11, 11]);
  });

  test("needsyou is the first four notes a fifth up, twice", () => {
    const { notes, seconds } = cue("acme", "needsyou");
    const done = cue("acme", "done")
      .notes.slice(0, 4)
      .map((note) => note.hz);
    expect(seconds).toBe(0.98);
    expect(notes).toHaveLength(8);
    // The second pass repeats the first, a fifth above the done cue.
    expect(notes.slice(4).map((note) => note.hz)).toEqual(notes.slice(0, 4).map((note) => note.hz));
    notes.slice(0, 4).forEach((note, i) => {
      expect(note.hz / (done[i] as number)).toBeCloseTo(2 ** (7 / 12), 10);
    });
    // Harder attack, faster decay than done: an alert, not a chime.
    expect(notes.map((note) => note.attack)).toEqual([0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002, 0.002]);
    expect(notes.map((note) => note.decay)).toEqual([20, 20, 20, 20, 20, 20, 20, 20]);
  });

  test("needsyou leaves a short tail, which is what keeps it unresolved", () => {
    const { notes, seconds } = cue("acme", "needsyou");
    const lastOnset = Math.max(...notes.map((note) => note.at));
    expect(seconds - lastOnset).toBeCloseTo(0.15, 10);
  });

  test("an unknown project still gets a cue", () => {
    expect(cue("", "done").notes).toHaveLength(5);
  });
});

/** The samples of a WAV, past the 44-byte header. */
function pcm(wav: Buffer): Buffer {
  return wav.subarray(44);
}

/** Highest absolute sample in a PCM buffer. */
function peakOf(samples: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < samples.length; i += 2) {
    peak = Math.max(peak, Math.abs(samples.readInt16LE(i)));
  }
  return peak;
}

/**
 * Peak of the last millisecond of a WAV. The cues are cut, not faded out, so the
 * tail still has energy; a single sample would be a phase accident.
 */
function tailPeak(wav: Buffer): number {
  const samples = pcm(wav);
  return peakOf(samples.subarray(samples.length - Math.ceil(0.001 * 22050) * 2));
}

describe("renderWav", () => {
  const wav = renderWav(cue("acme", "done"));

  test("is a 16-bit mono PCM WAV at 22050 Hz", () => {
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.subarray(12, 16).toString()).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(22050);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString()).toBe("data");
  });

  test("the declared lengths match the bytes", () => {
    expect(wav.readUInt32LE(40)).toBe(pcm(wav).length);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });

  test("holds samples: audible, silent at the first frame, ringing at the last", () => {
    expect(peakOf(pcm(wav))).toBeGreaterThan(5000);
    expect(pcm(wav).readInt16LE(0)).toBe(0);
    expect(tailPeak(wav)).toBeGreaterThan(100);
  });

  test("clamps notes that sum past full scale", () => {
    // Eight simultaneous notes at the same phase sum past 1.0, so the render only
    // stays inside Int16 if the mix is clamped rather than written as-is.
    const loud = {
      notes: Array.from({ length: 8 }, () => ({ hz: 440, at: 0, decay: 1, attack: 0.001 })),
      seconds: 0.05,
    };
    expect(peakOf(pcm(renderWav(loud)))).toBe(32767);
  });

  test("is longer for the needsyou cue, and its tail rings too", () => {
    const needsyou = renderWav(cue("acme", "needsyou"));
    expect(needsyou.length).toBeGreaterThan(wav.length);
    expect(needsyou.length - wav.length).toBe(Math.ceil((0.98 - 0.62) * 22050) * 2);
    expect(tailPeak(needsyou)).toBeGreaterThan(100);
  });
});

describe("cueFileName", () => {
  test("carries the project, a hash, the kind and the synthesis version", () => {
    expect(cueFileName("Acme Widgets", "done")).toMatch(
      new RegExp(`^acme-widgets-[0-9a-f]{8}-done-v${CUE_VERSION}\\.wav$`),
    );
  });

  test("an empty project falls back to a name", () => {
    expect(cueFileName("", "needsyou")).toMatch(new RegExp(`^project-[0-9a-f]{8}-needsyou-v${CUE_VERSION}\\.wav$`));
  });

  test("keeps the slug inside the cache directory", () => {
    expect(cueFileName("../../etc/passwd", "done")).not.toContain("/");
  });

  test("the kind and the project are part of the key", () => {
    expect(cueFileName("acme", "done")).not.toBe(cueFileName("acme", "needsyou"));
    expect(cueFileName("acme", "done")).not.toBe(cueFileName("globex", "done"));
  });
});

describe("ensureCue", () => {
  test("writes the cue this synthesis produces", () => {
    const dir = scratch();
    const path = ensureCue(dir, "acme", "done") as string;
    expect(path).toBe(join(dir, cueFileName("acme", "done")));
    expect(readFileSync(path).equals(renderWav(cue("acme", "done")))).toBe(true);
  });

  test("reuses an existing file instead of rewriting it", () => {
    const dir = scratch();
    const path = ensureCue(dir, "acme", "done") as string;
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(path, old, old);
    ensureCue(dir, "acme", "done");
    expect(statSync(path).mtimeMs).toBe(old.getTime());
  });

  test("removes cues from an older synthesis, for this project and kind only", () => {
    const dir = scratch();
    ensureCue(dir, "acme", "done");
    const stale = join(dir, cueFileName("acme", "done").replace(/-v\d+\.wav$/, "-v0.wav"));
    const otherKind = join(dir, cueFileName("acme", "needsyou").replace(/-v\d+\.wav$/, "-v0.wav"));
    const otherProject = join(dir, cueFileName("globex", "done").replace(/-v\d+\.wav$/, "-v0.wav"));
    for (const path of [stale, otherKind, otherProject]) writeFileSync(path, "old");
    ensureCue(dir, "acme", "done");
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(otherKind)).toBe(true);
    expect(existsSync(otherProject)).toBe(true);
  });

  test("keeps a fresh temp file but sweeps a dead one", () => {
    const dir = scratch();
    ensureCue(dir, "acme", "done");
    const prefix = join(dir, cueFileName("acme", "done").replace(/-v\d+\.wav$/, "-v0.wav"));
    const inFlight = `${prefix}.1.tmp`;
    const orphan = `${prefix}.2.tmp`;
    writeFileSync(inFlight, "half a cue");
    writeFileSync(orphan, "lost process");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(orphan, old, old);
    ensureCue(dir, "acme", "done");
    expect(existsSync(inFlight)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  test("reports an unusable cache instead of throwing", () => {
    const dir = scratch();
    const file = join(dir, "occupied");
    writeFileSync(file, "");
    expect(ensureCue(join(file, "notify"), "acme", "done")).toBeNull();
  });
});

describe("makeWaiter", () => {
  test("reports a clean exit as played", async () => {
    const { seen, spawnProcess } = spySpawn();
    const waiting = makeWaiter(spawnProcess)("afplay", ["/tmp/x.wav"], 5000);
    seen.exit?.(0);
    expect(await waiting).toBe("played");
  });

  test("reports a non-zero exit as failed, not as a missing player", async () => {
    const { seen, spawnProcess } = spySpawn();
    const waiting = makeWaiter(spawnProcess)("afplay", [], 5000);
    seen.exit?.(1);
    expect(await waiting).toBe("failed");
  });

  test("reports a spawn error as unstarted", async () => {
    const { seen, spawnProcess } = spySpawn();
    const waiting = makeWaiter(spawnProcess)("afplay", [], 5000);
    seen.error?.();
    expect(await waiting).toBe("unstarted");
  });

  test("reports a throwing spawn as unstarted", async () => {
    const { spawnProcess } = spySpawn({ throws: true });
    expect(await makeWaiter(spawnProcess)("afplay", [], 5000)).toBe("unstarted");
  });

  test("stops a player that never exits, and says so", async () => {
    const { seen, spawnProcess } = spySpawn();
    expect(await makeWaiter(spawnProcess)("afplay", [], 20)).toBe("timedout");
    expect(seen.kills).toBe(1);
  });

  test("clears the timeout once the player exits", async () => {
    const { seen, spawnProcess } = spySpawn();
    const cleared: unknown[] = [];
    const timers = {
      setTimeout: () => 7 as unknown as ReturnType<typeof setTimeout>,
      clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => cleared.push(handle),
    };
    const waiting = makeWaiter(spawnProcess, timers)("afplay", [], 5000);
    seen.exit?.(0);
    await waiting;
    expect(cleared).toEqual([7]);
  });

  test("runs the player in the foreground, so the caller can hear it finish", () => {
    const { seen, spawnProcess } = spySpawn();
    void makeWaiter(spawnProcess)("afplay", [], 5000);
    expect(seen.options).toEqual({ detached: false, stdio: "ignore" });
    expect(seen.events).toEqual(["exit", "error"]);
  });
});

describe("playCueAndWait", () => {
  test("gives the wait the clip length plus a margin", async () => {
    const budgets: number[] = [];
    await playCueAndWait("acme", "needsyou", {
      dir: scratch(),
      wait: async (_command, _args, timeoutMs) => {
        budgets.push(timeoutMs);
        return "played";
      },
    });
    expect(budgets).toEqual([0.98 * 1000 + 2000]);
  });

  test("does not resolve until the player exits", async () => {
    const { seen, spawnProcess } = spySpawn();
    const result = playCueAndWait("acme", "done", { dir: scratch(), wait: makeWaiter(spawnProcess) });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    seen.exit?.(0);
    expect(await result).toMatchObject({ played: true });
  });

  test("tells a failed player apart from a missing one", async () => {
    const dir = scratch();
    expect(await playCueAndWait("acme", "done", { dir, wait: async () => "unstarted" })).toMatchObject({
      played: false,
      reason: "could not start afplay",
    });
    expect(await playCueAndWait("acme", "done", { dir, wait: async () => "failed" })).toMatchObject({
      played: false,
      reason: "afplay failed",
    });
    expect(await playCueAndWait("acme", "done", { dir, wait: async () => "timedout" })).toMatchObject({
      played: false,
      reason: "afplay did not finish",
    });
  });

  test("reports an unwritable cache", async () => {
    const dir = scratch();
    const file = join(dir, "occupied");
    writeFileSync(file, "");
    const result = await playCueAndWait("acme", "done", { dir: join(file, "n"), wait: async () => "played" });
    expect(result).toMatchObject({ played: false, reason: "the cue cache is not writable" });
  });
});

describe("playCue", () => {
  test("plays the cached file with afplay", () => {
    const dir = scratch();
    const calls: { command: string; args: string[] }[] = [];
    const result = playCue("acme", "needsyou", {
      dir,
      play: (command, args) => {
        calls.push({ command, args });
        return true;
      },
    });
    expect(result.played).toBe(true);
    expect(calls).toEqual([{ command: "afplay", args: ["-v", "0.5", result.path as string] }]);
    expect(existsSync(result.path as string)).toBe(true);
  });

  test("reports a player that cannot start", () => {
    const result = playCue("acme", "done", { dir: scratch(), play: () => false });
    expect(result).toMatchObject({ played: false, reason: "could not start afplay" });
    expect(result.path).toBeString();
  });

  test("reports an unwritable cache", () => {
    const dir = scratch();
    const file = join(dir, "occupied");
    writeFileSync(file, "");
    const result = playCue("acme", "done", { dir: join(file, "notify"), play: () => true });
    expect(result).toMatchObject({ played: false, reason: "the cue cache is not writable" });
  });
});

/** A spawn stand-in that records its argv and hands back the listeners it got. */
function spySpawn(options: { throws?: boolean } = {}) {
  const seen: {
    command?: string;
    args?: string[];
    options?: unknown;
    events: string[];
    unrefs: number;
    kills: number;
    exit?: (code: number | null) => void;
    error?: () => void;
  } = { events: [], unrefs: 0, kills: 0 };
  const spawnProcess = ((command: string, args: string[], spawnOptions: unknown) => {
    if (options.throws) throw new Error("no player");
    seen.command = command;
    seen.args = args;
    seen.options = spawnOptions;
    return {
      on(event: string, listener: () => void) {
        seen.events.push(event);
        seen.error = listener;
        return this;
      },
      once(event: string, listener: (code: number | null) => void) {
        seen.events.push(event);
        if (event === "exit") seen.exit = listener;
        else seen.error = listener as () => void;
        return this;
      },
      unref() {
        seen.unrefs += 1;
      },
      kill() {
        seen.kills += 1;
      },
    };
  }) as unknown as SpawnProcess;
  return { seen, spawnProcess };
}

describe("makePlayer", () => {
  const playerWith = (options: { throws?: boolean } = {}) => {
    const { seen, spawnProcess } = spySpawn(options);
    return { seen, player: makePlayer(spawnProcess) };
  };

  test("spawns detached with no pipes, and detaches the child", () => {
    const { seen, player } = playerWith();
    expect(player("afplay", ["-v", "0.5", "/tmp/x.wav"])).toBe(true);
    expect(seen.command).toBe("afplay");
    expect(seen.args).toEqual(["-v", "0.5", "/tmp/x.wav"]);
    expect(seen.options).toEqual({ detached: true, stdio: "ignore" });
    expect(seen.unrefs).toBe(1);
  });

  test("listens for the asynchronous spawn error", () => {
    const { seen, player } = playerWith();
    player("afplay", []);
    expect(seen.events).toEqual(["error"]);
  });

  test("a throwing spawn is a failed cue, not a failed run", () => {
    const { player } = playerWith({ throws: true });
    expect(player("afplay", [])).toBe(false);
  });

  test("a missing player does not crash the process", async () => {
    expect(spawnPlayer("notify-no-such-player-xyz", [])).toBe(true);
    await Bun.sleep(50);
  });
});

describe("soundEnabled", () => {
  test("is on unless it is turned off", () => {
    expect(soundEnabled({}, "darwin")).toBe(true);
    expect(soundEnabled({ PI_NOTIFY_SOUNDS: "1" }, "darwin")).toBe(true);
    for (const value of ["0", "off", "OFF", " false "]) {
      expect(soundEnabled({ PI_NOTIFY_SOUNDS: value }, "darwin")).toBe(false);
    }
  });

  test("is off where the player does not exist", () => {
    expect(soundEnabled({}, "linux")).toBe(false);
    expect(soundEnabled({ PI_NOTIFY_SOUNDS: "1" }, "linux")).toBe(false);
  });
});

describe("soundIdleSeconds", () => {
  test("defaults to 20 seconds", () => {
    expect(soundIdleSeconds({})).toBe(20);
    expect(soundIdleSeconds({ PI_NOTIFY_SOUNDS_IDLE_SECONDS: "" })).toBe(20);
    expect(soundIdleSeconds({ PI_NOTIFY_SOUNDS_IDLE_SECONDS: "  " })).toBe(20);
  });

  test("reads a non-negative number", () => {
    expect(soundIdleSeconds({ PI_NOTIFY_SOUNDS_IDLE_SECONDS: "5" })).toBe(5);
    expect(soundIdleSeconds({ PI_NOTIFY_SOUNDS_IDLE_SECONDS: "0" })).toBe(0);
  });

  test("a malformed value keeps the default", () => {
    for (const value of ["-1", "abc", "NaN", "20s"]) {
      expect(soundIdleSeconds({ PI_NOTIFY_SOUNDS_IDLE_SECONDS: value })).toBe(20);
    }
  });
});

describe("cueDir", () => {
  test("lives in the user's cache directory", () => {
    expect(cueDir()).toBe(join(homedir(), "Library", "Caches", "llm", "notify"));
  });
});

describe("the cache stays small", () => {
  test("one file per project and kind", () => {
    const dir = scratch();
    mkdirSync(dir, { recursive: true });
    ensureCue(dir, "acme", "done");
    ensureCue(dir, "acme", "needsyou");
    ensureCue(dir, "globex", "done");
    expect(readdirSync(dir).sort()).toEqual(
      [cueFileName("acme", "done"), cueFileName("acme", "needsyou"), cueFileName("globex", "done")].sort(),
    );
  });
});
