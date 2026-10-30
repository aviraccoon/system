/**
 * Per-project notification cues, synthesized from the project name.
 *
 * A cue is a five-note motif drawn from a major pentatonic scale, so no random
 * draw contains a dissonant interval, and a project always renders the same
 * notes: the motif is a stable function of the project's directory name, which
 * is also the name the frame and the push carry. Two shapes share that motif:
 *
 * - `done`: the motif as a bell arpeggio that resolves.
 * - `needsyou`: the first four notes, a fifth up, twice, with a hard attack and
 *   a cut tail. The repetition is the "again" signal; the cut tail is what keeps
 *   it unresolved.
 *
 * Nothing here uses a sound file from the system: the samples are generated, so
 * adding a project costs no configuration. macOS only, because playback is
 * `afplay`; a Linux port needs a different player (and a different presence
 * signal, which `idle.ts` owns).
 *
 * The WAV is cached under the user's cache directory and is disposable: a missing
 * cue is regenerated on next use.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { seconds } from "./idle";

/** Bumped when the synthesis changes, so a stale cue cannot outlive the shape. */
export const CUE_VERSION = 1;

/** Loud enough to notice from another room, quiet enough not to startle. */
const VOLUME = "0.5";

const RATE = 22050;
const PENTATONIC = [0, 2, 4, 7, 9];
/** Intervals in scale steps; the repeats weight movement over standing still. */
const MOVES = [1, 1, 2, -1, -1, -2, 0];

export type CueKind = "done" | "needsyou";

interface Note {
  hz: number;
  /** Seconds from the start of the cue. */
  at: number;
  /** Exponential decay rate; higher is more staccato. */
  decay: number;
  attack: number;
}

interface Cue {
  notes: Note[];
  /** Length of the rendered audio, including the decay tail. */
  seconds: number;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** xorshift32, seeded from the project hash: the same project, the same notes. */
function prng(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    // Low bits of xorshift are weak; scramble before taking a modulus.
    return Math.imul(state, 0x2545f491) >>> 0;
  };
}

const midi = (degree: number): number => 69 + Math.floor(degree / 5) * 12 + PENTATONIC[degree % 5];

/** The pitch of a motif degree. */
export const hz = (degree: number): number => 440 * 2 ** ((midi(degree) - 69) / 12);

/**
 * Five scale degrees (0-14, three octaves of the pentatonic) for a project. The
 * key is the project name, so a worktree or a moved checkout keeps its cue.
 */
export function motif(project: string): number[] {
  const random = prng(fnv1a(project));
  const degrees = [random() % 10];
  for (let i = 1; i < 5; i++) {
    const previous = degrees[degrees.length - 1] as number;
    degrees.push(Math.max(0, Math.min(14, previous + MOVES[random() % MOVES.length])));
  }
  return degrees;
}

const transpose = (frequency: number, semitones: number): number => frequency * 2 ** (semitones / 12);

export function cue(project: string, kind: CueKind): Cue {
  const degrees = motif(project).map(hz);
  if (kind === "done") {
    const notes = degrees.map((frequency, i) => ({ hz: frequency, at: i * 0.11, decay: 11, attack: 0.004 }));
    return { notes, seconds: 0.62 };
  }
  const up = degrees.slice(0, 4).map((frequency) => transpose(frequency, 7));
  const notes: Note[] = [];
  for (const pass of [0, 1]) {
    up.forEach((frequency, i) => {
      notes.push({ hz: frequency, at: pass * 0.5 + i * 0.11, decay: 20, attack: 0.002 });
    });
  }
  return { notes, seconds: 0.98 };
}

/** A 16-bit mono WAV: a 44-byte header, then the clipped PCM samples. */
export function renderWav(cue: Cue): Buffer {
  const frames = Math.ceil(cue.seconds * RATE);
  const samples = new Float32Array(frames);
  for (const note of cue.notes) {
    const start = Math.floor(note.at * RATE);
    for (let frame = Math.max(0, start); frame < frames; frame++) {
      const t = (frame - start) / RATE;
      const envelope = Math.exp(-t * note.decay) * Math.min(1, t / note.attack);
      const tone =
        Math.sin(2 * Math.PI * note.hz * t) * 0.62 +
        Math.sin(4 * Math.PI * note.hz * t) * 0.2 +
        Math.sin(6 * Math.PI * note.hz * t) * 0.08;
      samples[frame] = (samples[frame] as number) + tone * envelope * 0.22;
    }
  }
  const data = Buffer.alloc(frames * 2);
  for (let frame = 0; frame < frames; frame++) {
    const value = Math.max(-1, Math.min(1, samples[frame] as number));
    data.writeInt16LE(Math.round(value * 32767), frame * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Readable, and the hash keeps the slug from being the whole key. */
export function cueFileName(project: string, kind: CueKind): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const hash = fnv1a(project).toString(16).padStart(8, "0");
  return `${slug || "project"}-${hash}-${kind}-v${CUE_VERSION}.wav`;
}

export function cueDir(): string {
  return join(homedir(), "Library", "Caches", "llm", "notify");
}

/**
 * The cached cue for a project, written on first use. Null when the cache is
 * unusable: a cue is best effort and must never fail a run.
 */
export function ensureCue(dir: string, project: string, kind: CueKind): string | null {
  const name = cueFileName(project, kind);
  const path = join(dir, name);
  let cached = false;
  try {
    statSync(path);
    cached = true;
  } catch {
    // Missing, so write it below.
  }
  if (!cached) {
    try {
      mkdirSync(dir, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, renderWav(cue(project, kind)));
      renameSync(temporary, path);
    } catch {
      return null;
    }
  }
  // On both paths: a crash between the write and the prune, or a synthesis
  // change while the file already existed, leaves a stale cue behind otherwise.
  pruneVersions(dir, name);
  return path;
}

/** A temp file this young may belong to a write in flight in another process. */
const TEMP_GRACE_MS = 60_000;

/** Remove cues for the same project and kind written by another synthesis. */
function pruneVersions(dir: string, name: string): void {
  const prefix = name.slice(0, name.lastIndexOf("-v"));
  const cutoff = Date.now() - TEMP_GRACE_MS;
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`${prefix}-v`) || entry === name) continue;
      const path = join(dir, entry);
      if (entry.endsWith(".tmp") && !olderThan(path, cutoff)) continue;
      try {
        unlinkSync(path);
      } catch {
        // Another process holds it, or it is already gone.
      }
    }
  } catch {
    // An unreadable directory leaves the stale files behind, nothing worse.
  }
}

function olderThan(path: string, cutoff: number): boolean {
  try {
    return statSync(path).mtimeMs < cutoff;
  } catch {
    return false;
  }
}

export type Player = (command: string, args: string[]) => boolean;

/** The slice of `child_process.spawn` the players need, so a test can watch it. */
export type SpawnProcess = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore" },
) => {
  on(event: "error", listener: () => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: () => void): unknown;
  unref(): void;
  kill(): void;
};

type Child = ReturnType<SpawnProcess>;

/**
 * Detached, because `afplay` blocks for the whole clip and pi awaits this event:
 * an awaited player would hold the session for the length of the cue.
 */
export function makePlayer(spawnProcess: SpawnProcess): Player {
  return (command, args) => {
    try {
      const child = spawnProcess(command, args, { detached: true, stdio: "ignore" });
      // A missing player fails asynchronously; an unhandled 'error' would crash
      // the session, and a cue is never worth that.
      child.on("error", () => undefined);
      child.unref();
      return true;
    } catch {
      return false;
    }
  };
}

export const spawnPlayer: Player = makePlayer(spawn);

/** How a playback ended: cleanly, with a failure, never started, or never
 * finished. */
export type Playback = "played" | "failed" | "unstarted" | "timedout";

/** afplay's startup allowance; a player still running past it is wedged. */
const PLAYER_START_MS = 2000;

/**
 * A player that resolves when playback is over. Resolves `played` on exit 0,
 * `failed` on a non-zero exit, `unstarted` when the player could not be spawned,
 * and `timedout` when it had to be stopped. The timeout bounds a player that
 * never exits, which would otherwise hang the caller forever.
 */
export type Waiter = (command: string, args: string[], timeoutMs: number) => Promise<Playback>;

/** The timer functions, injectable so a test can watch them being cleared. */
export interface Timers {
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => void;
}

const realTimers: Timers = { setTimeout, clearTimeout };

export function makeWaiter(spawnProcess: SpawnProcess, timers: Timers = realTimers): Waiter {
  return (command, args, timeoutMs) =>
    new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let child: Child | undefined;
      const done = (outcome: Playback) => {
        timers.clearTimeout(timer);
        resolve(outcome);
      };
      try {
        child = spawnProcess(command, args, { detached: false, stdio: "ignore" });
        timer = timers.setTimeout(() => {
          // A player that outlives its budget is stopped, not merely reported:
          // leaving it running would let the next cue start underneath it.
          child?.kill();
          done("timedout");
        }, timeoutMs);
        child.once("exit", (code) => done(code === 0 ? "played" : "failed"));
        child.once("error", () => done("unstarted"));
      } catch {
        done("unstarted");
      }
    });
}

export const spawnWaiter: Waiter = makeWaiter(spawn);

export interface CueResult {
  played: boolean;
  path?: string;
  reason?: string;
}

export interface CueDeps {
  dir?: string;
  play?: Player;
}

/** Generate (if needed), then play a project's cue. Never throws. */
export function playCue(project: string, kind: CueKind, deps: CueDeps = {}): CueResult {
  const path = ensureCue(deps.dir ?? cueDir(), project, kind);
  if (!path) return { played: false, reason: "the cue cache is not writable" };
  if (!(deps.play ?? spawnPlayer)("afplay", ["-v", VOLUME, path])) {
    return { played: false, path, reason: "could not start afplay" };
  }
  return { played: true, path };
}

/**
 * Play a cue and resolve once the clip has finished. For callers that play two
 * cues back to back: a detached player returns immediately, so waiting on the
 * rendered length would start the second clip before the first ended.
 */
export async function playCueAndWait(
  project: string,
  kind: CueKind,
  deps: CueDeps & { wait?: Waiter } = {},
): Promise<CueResult> {
  const path = ensureCue(deps.dir ?? cueDir(), project, kind);
  if (!path) return { played: false, reason: "the cue cache is not writable" };
  const timeout = cue(project, kind).seconds * 1000 + PLAYER_START_MS;
  const outcome = await (deps.wait ?? spawnWaiter)("afplay", ["-v", VOLUME, path], timeout);
  if (outcome === "played") return { played: true, path };
  const reasons = {
    failed: "afplay failed",
    unstarted: "could not start afplay",
    timedout: "afplay did not finish",
  };
  return { played: false, path, reason: reasons[outcome] };
}

/**
 * `PI_NOTIFY_SOUNDS` set to `0`, `off` or `false` silences the cues; unset or
 * anything else plays them. macOS only, where the player is `afplay`.
 */
export function soundEnabled(env: NodeJS.ProcessEnv, platform: string = process.platform): boolean {
  if (platform !== "darwin") return false;
  const value = env.PI_NOTIFY_SOUNDS?.trim().toLowerCase();
  return value !== "0" && value !== "off" && value !== "false";
}

/** Idle seconds that count as away for a cue. Lower than the push gate's: a cue
 * costs a sound, a push buzzes a phone. */
const DEFAULT_SOUND_IDLE_SECONDS = 20;

export function soundIdleSeconds(env: NodeJS.ProcessEnv): number {
  return seconds(env.PI_NOTIFY_SOUNDS_IDLE_SECONDS, DEFAULT_SOUND_IDLE_SECONDS);
}
