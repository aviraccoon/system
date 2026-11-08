/**
 * What a settle announces, and what survives it.
 *
 * Only a real session shows this, because the facts a notification reports are accumulated by the
 * event handlers: a run that ends while another extension has work in flight has to keep counting,
 * or the notification that follows that work reports only the segment a wake started.
 *
 * The frame is captured by swapping `process.stdout.write` and the push by swapping `fetch`: a topic
 * is configured, so the push path runs, and nothing leaves the machine. The cue is off
 * (`PI_NOTIFY_SOUNDS=0`).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { markPending } from "../shared/pending-work";
import { createHarness, type Harness, type ScriptedResponse } from "../shared/testing/session-harness";
import notify from "./index";

const ENV_KEYS = [
  "PI_PENDING_WORK_DIR",
  "PI_NOTIFY_PROTOCOL",
  "PI_NOTIFY_OFF",
  "PI_NOTIFY_NTFY_URL",
  "PI_NOTIFY_NTFY_FILE",
  "PI_NOTIFY_SOUNDS",
  "PI_NOTIFY_IDLE_SECONDS",
  "PI_NOTIFY_MIN_RUN_SECONDS",
  "TMUX",
  "TERM_PROGRAM",
] as const;

const bash = (command: string): ScriptedResponse => ({ toolCalls: [{ name: "bash", arguments: { command } }] });

let root: string;
let saved: Map<string, string | undefined>;
let originalFetch: typeof fetch;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notify-settle-"));
  saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  // A forced protocol is what makes a frame land on a machine with no notifying terminal; a bare topic
  // is what makes the push path run; the gates are opened so a short run still pushes.
  process.env.PI_NOTIFY_PROTOCOL = "osc777";
  process.env.PI_PENDING_WORK_DIR = path.join(root, "pending");
  process.env.PI_NOTIFY_NTFY_FILE = path.join(root, "no-topic");
  process.env.PI_NOTIFY_NTFY_URL = "test-topic";
  process.env.PI_NOTIFY_SOUNDS = "0";
  process.env.PI_NOTIFY_IDLE_SECONDS = "0";
  process.env.PI_NOTIFY_MIN_RUN_SECONDS = "0";
  delete process.env.PI_NOTIFY_OFF;
  delete process.env.TMUX;
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

/** Capture the frames a case writes, and hand back the undo. */
function captureFrames(): { frames: string[]; restore: () => void } {
  const frames: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    frames.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { frames, restore: () => (process.stdout.write = original) };
}

interface CapturedPush {
  title: string;
  body: string;
}

/** Answer the push instead of sending it, recording what ntfy would have been told. */
function capturePushes(): { pushes: CapturedPush[]; restore: () => void } {
  const pushes: CapturedPush[] = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = new Map(Object.entries(init.headers as Record<string, string>));
    pushes.push({ title: headers.get("Title") ?? "", body: String(init.body) });
    return new Response("", { status: 200 });
  }) as typeof fetch;
  return { pushes, restore: () => (globalThis.fetch = originalFetch) };
}

/** Wait for the next frame, then for the push that follows it; both are written from pi's event. */
async function waitForCount<T>(items: T[], count: number, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (items.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${items.length} ${what} written, not ${count}`);
}

test("a settle with work in flight says so, and the next one reports the whole span", async () => {
  const capture = captureFrames();
  const pushCapture = capturePushes();
  let harness: Harness | undefined;
  const responses = [bash("echo one"), { text: "first" }, bash("echo two"), { text: "second" }];
  try {
    const live = await createHarness({ tools: ["bash"], extensions: [notify], responses });
    harness = live;
    const release = markPending(live.session.sessionManager.getSessionId(), { kind: "job", id: "j-test" });

    await live.run("first");
    await waitForCount(capture.frames, 1, "frame");
    await waitForCount(pushCapture.pushes, 1, "push");
    expect(capture.frames[0]).toContain("1 job running");
    expect(pushCapture.pushes[0]?.title).toContain("1 job running");

    release();
    await live.run("second");
    await waitForCount(capture.frames, 2, "frame");
    await waitForCount(pushCapture.pushes, 2, "push");
    // Both bash calls, because the run's facts carried across the settle that still had work behind it.
    expect(capture.frames[1]).toContain("2 tools");
    expect(capture.frames[1]).not.toContain("running");
    expect(pushCapture.pushes[1]?.title).not.toContain("running");
    expect(pushCapture.pushes[1]?.body).toContain("2 tools");
  } finally {
    capture.restore();
    pushCapture.restore();
    harness?.cleanup();
  }
}, 20_000);
