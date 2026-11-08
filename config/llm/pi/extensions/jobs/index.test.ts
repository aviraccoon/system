/**
 * Where in a run the completion lands.
 *
 * Only a real session can show this: a completion is steered, so pi hands it to the model after the
 * tool calls in flight and before its next step, and a completion that lands on an agent which has
 * ended its turn starts a new one. A follow-up holds it until the agent stops, which is the wait that
 * pushes a model into polling a job it was told not to poll. The rest of the extension is pinned per
 * module; this file covers the delivery decisions that live in the event wiring.
 *
 * The first test holds the run open with a tool it owns instead of with scripted delays, so no
 * assertion of its own rests on how long a turn takes. The second one has to let the run end before
 * the job does, so it runs a job long enough that the two scripted turns finish inside it. A promoted
 * job costs real time regardless: the foreground window has a one-second floor and the job must
 * outlive it.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { listPending } from "../shared/pending-work";
import { createHarness, type Harness, type ScriptedResponse } from "../shared/testing/session-harness";
import jobsExtension from "./index";

/** The foreground window's floor; a call that outlives it is promoted. */
const FOREGROUND_SECONDS = "1";
/** Outlives the window plus the record read the tool does before it answers. */
const JOB_SECONDS = 2;
/**
 * The second test lets the run end before the job does, so the job has to outlive the two scripted
 * turns: two seconds past the foreground window is the slack they get on a loaded machine.
 */
const SELF_ENDING_JOB_SECONDS = 3;
/** How long the wake may take to reach the agent's queue once the job has exited. */
const WAKE_TIMEOUT_MS = 10_000;
/**
 * The test's deadline. Waits run in series but each poll throws at its own deadline, so at most one can
 * elapse per test: the budget covers that wait, the job it promotes (up to three seconds) and the run's
 * own work.
 */
const TEST_TIMEOUT_MS = WAKE_TIMEOUT_MS * 2 + 5_000;

const bash = (command: string): ScriptedResponse => ({ toolCalls: [{ name: "bash", arguments: { command } }] });

/** The completion's own header (`[job <id> finished: …]`), which no tool result carries. */
const COMPLETION = "[job j-";
const carriesCompletion = (context: TranscriptContext | undefined): boolean =>
  (context?.messages ?? []).some((message) => JSON.stringify(message).includes(COMPLETION));

const JOB_ENV_KEYS = [
  "PI_JOBS_DIR",
  "PI_JOBS_FOREGROUND_SECONDS",
  "PI_PENDING_WORK_DIR",
  "PI_BASH_SANDBOX",
  "PI_SUBAGENT",
] as const;

/**
 * Point the extension at a temp job directory for the duration of one test. The sandbox markers must
 * not leak in from the shell running the suite: the extension leaves `bash` unregistered when a
 * confined shell owns the name, and the job it starts belongs to this session.
 */
function isolateJobsEnv(jobsDir: string): () => void {
  const saved = new Map(JOB_ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.PI_JOBS_DIR = jobsDir;
  process.env.PI_JOBS_FOREGROUND_SECONDS = FOREGROUND_SECONDS;
  process.env.PI_PENDING_WORK_DIR = join(jobsDir, "pending");
  delete process.env.PI_BASH_SANDBOX;
  delete process.env.PI_SUBAGENT;
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Poll `done` to a deadline, then fail with what `seen` reports. No wait here rests on how long
 * `onExit`'s timer takes.
 */
async function until(seen: () => string, done: () => boolean, timeoutMs = WAKE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${seen()} after ${timeoutMs}ms`);
}

test(
  "a completion reaches the model while it is still working",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobs-wake-"));
    const restoreEnv = isolateJobsEnv(dir);

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
      const live = await createHarness({ tools: ["bash", "hold"], extensions: [jobsExtension, hold], responses });
      harness = live;
      run = live.run("start the job");
      await live.waitForEvent((event) => event.type === "tool_execution_start" && event.toolName === "hold", {
        description: "the hold tool to start",
      });
      await until(
        () =>
          `no completion was queued for the running turn (a ${JOB_SECONDS}s job must outlive the ${FOREGROUND_SECONDS}s foreground window)`,
        () => live.session.agent.peekQueuedMessages().some((message) => JSON.stringify(message).includes(COMPLETION)),
      );
      release();
      await run;

      const wakeIndex = live.modelContexts.findIndex(carriesCompletion);
      // The completion reached the model in the call right after the batch it queued behind, with a
      // scripted tool turn still to run.
      expect(wakeIndex).toBe(2);
      // Four provider calls for the four scripted turns: the completion did not start a turn of its own.
      expect(live.modelCalls()).toBe(4);
    } finally {
      release();
      // Await a run left in flight so a timeout above does not surface its rejection as an unhandled
      // error beside the real failure; the primary error still propagates from the try.
      await run?.catch(() => {});
      harness?.cleanup();
      rmSync(dir, { recursive: true, force: true });
      restoreEnv();
    }
  },
  TEST_TIMEOUT_MS,
);

test(
  "a completion starts a turn once the agent has ended its own",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobs-wake-"));
    const restoreEnv = isolateJobsEnv(dir);
    // The first turn promotes the job and the second ends the run. Nothing is left to hold it open, so
    // only the completion can produce a third call; the script's third turn is there to answer it.
    const responses = [bash(`sleep ${SELF_ENDING_JOB_SECONDS}`), { text: "ended the turn" }, { text: "woken" }];

    let harness: Harness | undefined;
    try {
      const live = await createHarness({ tools: ["bash"], extensions: [jobsExtension], responses });
      harness = live;
      await live.run("start the job");
      const settledCalls = live.modelCalls();
      expect(settledCalls).toBe(2);
      // A promoted job is work in flight, which is what a notification reads to say the run is not over.
      const session = live.session.sessionManager.getSessionId();
      expect(listPending(session).map((item) => item.kind)).toEqual(["job"]);
      await until(
        () => `the model was called ${live.modelCalls()} time(s), not ${settledCalls + 1}`,
        () => live.modelCalls() > settledCalls,
      );

      // The completion reached the model in a run of its own, started after the agent had settled.
      expect(carriesCompletion(live.modelContexts.at(-1))).toBe(true);
      const settled = live.events.findIndex((event) => event.type === "agent_settled");
      const shown = live.events.findIndex(
        (event) => event.type === "message_start" && JSON.stringify(event.message).includes(COMPLETION),
      );
      expect(settled).toBeGreaterThanOrEqual(0);
      expect(shown).toBeGreaterThan(settled);
      // The woken run is still streaming when the third call starts; let it settle before cleanup
      // aborts it.
      await until(
        () => `the session settled ${live.eventsOfType("agent_settled").length} time(s), not 2`,
        () => live.eventsOfType("agent_settled").length >= 2,
      );
      // The job's exit released the marker, so the next notification reports a finished run.
      expect(listPending(session)).toEqual([]);
    } finally {
      harness?.cleanup();
      rmSync(dir, { recursive: true, force: true });
      restoreEnv();
    }
  },
  TEST_TIMEOUT_MS,
);
