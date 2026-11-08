/**
 * Where in a run the completion lands.
 *
 * Only a real session can show this: a completion is steered, so pi hands it to the model after the
 * tool calls in flight and before its next step. A follow-up holds it until the agent stops, which is
 * the wait that pushes a model into polling a job it was told not to poll. The rest of the extension
 * is pinned per module; this file covers the one decision that lives in the event wiring.
 *
 * The run is held open by a tool the test owns instead of by scripted delays, so no assertion rests
 * on how long a turn takes. A promoted job costs real time regardless: the foreground window has a
 * one-second floor and the job must outlive it.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHarness, type Harness, type ScriptedResponse } from "../shared/testing/session-harness";
import jobsExtension from "./index";

/** The foreground window's floor; a call that outlives it is promoted. */
const FOREGROUND_SECONDS = "1";
/** Outlives the window plus the record read the tool does before it answers. */
const JOB_SECONDS = 2;
/** How long the wake may take to reach the agent's queue once the job has exited. */
const WAKE_TIMEOUT_MS = 10_000;
/**
 * The test's deadline. The harness's wait for the held turn (its own 10 s default) and this file's
 * wake wait run in series, so the budget has to cover both plus the run's own work; each wait throws
 * at its own deadline, so bun's timeout never cuts either short.
 */
const TEST_TIMEOUT_MS = WAKE_TIMEOUT_MS * 2 + 5_000;

const bash = (command: string): ScriptedResponse => ({ toolCalls: [{ name: "bash", arguments: { command } }] });

/** The completion's own header (`[job <id> finished: …]`), which no tool result carries. */
const COMPLETION = "[job j-";
const carriesCompletion = (context: TranscriptContext): boolean =>
  context.messages.some((message) => JSON.stringify(message).includes(COMPLETION));

/**
 * Wait until the completion is queued for the running turn. That is the wake's own state, so the
 * release does not rest on how long `onExit`'s timer takes, and it names the message the assertion
 * looks for rather than any queued message.
 */
async function waitForQueuedWake(harness: Harness, jobsDir: string, timeoutMs = WAKE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const queued = harness.session.agent.peekQueuedMessages();
    if (queued.some((message) => JSON.stringify(message).includes(COMPLETION))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `no completion was queued within ${timeoutMs}ms; if the job never promoted, the ${JOB_SECONDS}s command did not outlive the foreground window (records in ${jobsDir})`,
  );
}

test(
  "a completion reaches the model while it is still working",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobs-wake-"));
    const keys = ["PI_JOBS_DIR", "PI_JOBS_FOREGROUND_SECONDS", "PI_BASH_SANDBOX", "PI_SUBAGENT"] as const;
    const saved = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.PI_JOBS_DIR = dir;
    process.env.PI_JOBS_FOREGROUND_SECONDS = FOREGROUND_SECONDS;
    // The extension leaves `bash` unregistered when a confined shell owns the name, and the job it
    // starts belongs to this session, so the sandbox markers must not leak in from the shell running the suite.
    delete process.env.PI_BASH_SANDBOX;
    delete process.env.PI_SUBAGENT;

    // Two held turns, so a completion queued during the first one has a whole tool batch to wait out:
    // a follow-up cannot be delivered between them, which is what separates the two delivery modes.
    // The trailing text turns keep a completion that arrived after the run's own stop from cycling the
    // scripted calls.
    const responses = [
      bash(`sleep ${JOB_SECONDS}`),
      { toolCalls: [{ name: "hold", arguments: {} }] },
      { toolCalls: [{ name: "hold", arguments: {} }] },
      { text: "done" },
      { text: "done" },
    ];

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "hold",
        label: "hold",
        description: "Keeps the run in flight until the test releases it.",
        parameters: Type.Object({}),
        async execute() {
          await held;
          return { content: [{ type: "text" as const, text: "released" }], details: {} };
        },
      });
    };

    let harness: Harness | undefined;
    let run: Promise<void> | undefined;
    try {
      harness = await createHarness({ tools: ["bash", "hold"], extensions: [jobsExtension, hold], responses });
      run = harness.run("start the job");
      await harness.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "hold", {
        description: "the hold tool to start",
      });
      await waitForQueuedWake(harness, dir);
      release();
      await run;

      const wakeIndex = harness.modelContexts.findIndex(carriesCompletion);
      // The completion reached the model in the call right after the batch it queued behind, with a
      // scripted tool turn still to run.
      expect(wakeIndex).toBe(2);
      // Four provider calls for the four scripted turns: the completion did not start a turn of its own.
      expect(harness.modelCalls()).toBe(4);
    } finally {
      release();
      // Await a run left in flight so a timeout above does not surface its rejection as an unhandled
      // error beside the real failure; the primary error still propagates from the try.
      await run?.catch(() => {});
      harness?.cleanup();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
  TEST_TIMEOUT_MS,
);
