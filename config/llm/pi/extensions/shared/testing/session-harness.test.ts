/**
 * The harness's own pins. A test helper that has never been proven to carry an event, an injected
 * message or an isolated environment is the same defect as a pin that cannot fail: every test written
 * on top of it would inherit the claim without checking it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHarness, HARNESS_ROOT_PREFIX, type Harness, plain } from "./session-harness";

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe("scripted model", () => {
  test("a reply reaches the transcript, and the host emits its own event order", async () => {
    harness = await createHarness({ responses: ["first reply"] });
    await harness.run("hello");

    expect(harness.lastText()).toBe("first reply");
    expect(harness.modelCalls()).toBe(1);

    const sequence = harness.events
      .map((event) => event.type)
      .filter((type) => ["agent_start", "agent_end", "agent_settled"].includes(type));
    expect(sequence).toEqual(["agent_start", "agent_end", "agent_settled"]);

    // The two fields an extension branches on, and what `run()` waits for. A pi release that stopped
    // ending a run with a settle would leave every test here racing the next turn.
    expect(harness.eventsOfType("agent_end")[0].willRetry).toBe(false);
    expect(harness.eventsOfType("agent_settled")[0].aborted).toBe(false);
    expect(harness.events.at(-1)?.type).toBe("agent_settled");

    // The context is what the model was handed: the system prompt and the user turn.
    const messages = harness.modelContexts[0].messages;
    expect(messages.some((message) => message.role === "system")).toBe(true);
    const userTurn = messages.find((message) => message.role === "user");
    expect(JSON.stringify(userTurn?.content)).toContain("hello");
  });

  test("responses cycle, so a multi-turn run is scripted turn by turn", async () => {
    harness = await createHarness({ responses: ["one", "two"] });
    await harness.run("first");
    expect(harness.lastText()).toBe("one");
    await harness.run("second");
    expect(harness.lastText()).toBe("two");
    expect(harness.modelCalls()).toBe(2);
  });
});

describe("real extension loading", () => {
  test("the session start handler runs once the host binds the UI", async () => {
    let started = 0;
    let hasUI: boolean | undefined;
    harness = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("session_start", (_event, ctx) => {
            started++;
            hasUI = ctx.hasUI;
          });
        },
      ],
      responses: ["ack"],
    });
    expect(started).toBe(1);
    expect(harness.ui).toBeDefined();

    await harness.run("hello");
    expect(started).toBe(1);
    expect(hasUI).toBe(true);
  });

  test("ui: false binds pi's no-op UI, so hasUI is false and a styled status still works", async () => {
    let hasUI: boolean | undefined;
    let styled: string | undefined;
    harness = await createHarness({
      ui: false,
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("session_start", (_event, ctx) => {
            hasUI = ctx.hasUI;
            ctx.ui.notify("nobody is listening", "warning");
            styled = ctx.ui.theme.fg("muted", "4 jobs");
          });
        },
      ],
      responses: ["ack"],
    });
    await harness.run("hello");

    expect(hasUI).toBe(false);
    expect(harness.ui).toBeUndefined();
    expect(plain(styled)).toBe("4 jobs");
  });

  test("toasts, footer status and dialog answers are recorded", async () => {
    harness = await createHarness({
      ui: { confirm: [true] },
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", async (_event, ctx) => {
            ctx.ui.notify("hello from the extension", "info");
            ctx.ui.setStatus("probe", "working");
            const allowed = await ctx.ui.confirm("Run it?", "A dialog nobody sees.");
            ctx.ui.setStatus("answer", String(allowed));
          });
        },
      ],
      responses: ["ack"],
    });
    const ui = harness.ui;
    if (!ui) throw new Error("the harness bound no UI");
    await harness.run("hello");

    expect(ui.notifications.map((entry) => entry.message)).toContain("hello from the extension");
    expect(ui.status("probe")).toBe("working");
    expect(ui.status("answer")).toBe("true");
    expect(ui.dialogs).toEqual([{ kind: "confirm", title: "Run it?", message: "A dialog nobody sees." }]);
  });

  test("a styled status keeps the theme's codes, and `plain` reads the text", async () => {
    harness = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", (_event, ctx) => {
            ctx.ui.setStatus("styled", ctx.ui.theme.fg("muted", "4 jobs"));
          });
        },
      ],
      responses: ["ack"],
    });
    await harness.run("hello");

    const raw = harness.ui?.status("styled");
    expect(raw).not.toBe("4 jobs");
    expect(plain(raw)).toBe("4 jobs");
  });

  test("a dialog with no scripted answer takes the safe side", async () => {
    harness = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", async (_event, ctx) => {
            ctx.ui.setStatus("answer", String(await ctx.ui.confirm("Run it?", "Nobody answers.")));
          });
        },
      ],
      responses: ["ack"],
    });
    await harness.run("hello");
    expect(harness.ui?.status("answer")).toBe("false");
  });

  test("an extension's hooks fire in order", async () => {
    const seen: string[] = [];
    harness = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("session_start", () => {
            seen.push("session_start");
          });
          pi.on("before_agent_start", () => {
            seen.push("before_agent_start");
          });
          pi.on("agent_start", () => {
            seen.push("agent_start");
          });
          pi.on("agent_end", () => {
            seen.push("agent_end");
          });
          pi.on("agent_settled", () => {
            seen.push("agent_settled");
          });
        },
      ],
      responses: ["ack"],
    });
    await harness.run("hello");

    expect(seen).toEqual(["session_start", "before_agent_start", "agent_start", "agent_end", "agent_settled"]);
  });

  test("a message an extension returns is delivered to the session", async () => {
    harness = await createHarness({
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", async () => ({
            message: { customType: "harness-note", content: "injected by the extension", display: false },
          }));
        },
      ],
      responses: ["ack"],
    });
    await harness.run("hello");

    const custom = harness
      .eventsOfType("message_start")
      .map((event) => event.message)
      .filter((message) => message.role === "custom");
    expect(custom.map((message) => message.customType)).toContain("harness-note");
    expect(custom.some((message) => message.content === "injected by the extension")).toBe(true);
  });

  test("a tool the model calls runs for real, and its result comes back", async () => {
    harness = await createHarness({
      tools: ["probe"],
      extensions: [
        (pi: ExtensionAPI) => {
          pi.registerTool({
            name: "probe",
            label: "Probe",
            description: "Records that it ran.",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text" as const, text: "probe ran" }], details: {} }),
          });
        },
      ],
      responses: [{ toolCalls: [{ name: "probe", arguments: {} }] }, "finished"],
    });
    await harness.run("use the probe");

    const results = harness.toolResults();
    expect(results.map((result) => result.toolName)).toEqual(["probe"]);
    expect(JSON.stringify(results[0].result)).toContain("probe ran");
    expect(harness.lastText()).toBe("finished");
    expect(harness.modelCalls()).toBe(2);
    // The allowlist held: without it the run would also carry pi's default tools.
    expect(harness.session.getActiveToolNames()).toEqual(["probe"]);
  });

  test("a failed turn rejects the prompt instead of resolving with no answer", async () => {
    harness = await createHarness({ responses: [{ error: "the provider went away" }] });
    const failure = await harness.run("hello").catch((error: Error) => error.message);
    expect(failure).toContain("the provider went away");
    expect(harness.lastText()).toBeUndefined();
  });

  test("a select dialog records the options it offered, and a custom component refuses without a terminal", async () => {
    harness = await createHarness({
      ui: { select: ["b"] },
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", async (_event, ctx) => {
            ctx.ui.setStatus("picked", (await ctx.ui.select("Pick one", ["a", "b"])) ?? "none");
            const custom = await ctx.ui
              .custom(() => ({ render: () => [], invalidate: () => {}, handleInput: () => {} }))
              .catch((error: Error) => error.message);
            ctx.ui.setStatus("custom", String(custom));
          });
        },
      ],
      responses: ["ack"],
    });
    await harness.run("hello");

    const ui = harness.ui;
    if (!ui) throw new Error("the harness bound no UI");
    expect(ui.dialogs[0]).toEqual({ kind: "select", title: "Pick one", options: ["a", "b"] });
    expect(ui.status("picked")).toBe("b");
    expect(ui.status("custom")).toContain("no terminal");
  });

  test("input, editor and a scripted custom answer reach the extension", async () => {
    harness = await createHarness({
      ui: { input: ["typed"], editor: ["prefilled"], custom: ["closed"] },
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("before_agent_start", async (_event, ctx) => {
            ctx.ui.setStatus("input", (await ctx.ui.input("Name", "type here")) ?? "none");
            ctx.ui.setStatus("editor", (await ctx.ui.editor("Body", "seed")) ?? "none");
            const closed = await ctx.ui.custom(() => ({
              render: () => [],
              invalidate: () => {},
              handleInput: () => {},
            }));
            ctx.ui.setStatus("custom", String(closed));
          });
        },
      ],
      responses: ["ack"],
    });
    await harness.run("hello");

    const ui = harness.ui;
    if (!ui) throw new Error("the harness bound no UI");
    expect(ui.status("input")).toBe("typed");
    expect(ui.status("editor")).toBe("prefilled");
    expect(ui.status("custom")).toBe("closed");
    expect(ui.dialogs).toEqual([
      { kind: "input", title: "Name", message: "type here" },
      { kind: "editor", title: "Body", message: "seed" },
      { kind: "custom" },
    ]);
  });

  test("explicit tool-call ids are kept, and a failing tool is reported as one", async () => {
    harness = await createHarness({
      tools: ["probe"],
      extensions: [
        (pi: ExtensionAPI) => {
          pi.registerTool({
            name: "probe",
            label: "Probe",
            description: "Always fails.",
            parameters: Type.Object({}),
            execute: async () => {
              throw new Error("the probe exploded");
            },
          });
        },
      ],
      responses: [
        {
          toolCalls: [
            { id: "call-a", name: "probe", arguments: {} },
            { id: "call-b", name: "probe", arguments: {} },
          ],
        },
        "done",
      ],
    });
    await harness.run("use the probe");

    expect(harness.eventsOfType("tool_execution_end").map((event) => event.toolCallId)).toEqual(["call-a", "call-b"]);
    expect(harness.toolResults().map((result) => result.isError)).toEqual([true, true]);
  });

  test("a retryable failure that pi recovers from does not fail the run", async () => {
    harness = await createHarness({
      settings: { retry: { baseDelayMs: 1 } },
      responses: [{ error: "429 rate limit exceeded" }, "recovered"],
    });
    await harness.run("hello");

    expect(harness.lastText()).toBe("recovered");
    expect(harness.modelCalls()).toBe(2);
    expect(harness.eventsOfType("auto_retry_start").length).toBe(1);
  });
});

/** What the harness changed: a value it altered, or a variable it added with a value. */
function envProblems(host: Map<string, string | undefined>, current: Map<string, string | undefined>): string[] {
  const problems: string[] = [];
  for (const [key, value] of host) {
    if (current.get(key) !== value) problems.push(`${key}: was ${value}, now ${current.get(key)}`);
  }
  for (const [key, value] of current) {
    if (!host.has(key) && value !== undefined) problems.push(`${key}: added with a value`);
  }
  return problems;
}

const envSnapshot = () => new Map(Object.entries(process.env));

describe("isolation", () => {
  test("the harness leaves the process environment alone", async () => {
    // Sampled inside the extension factory too, because that is where the loader runs the factories:
    // a redirect that lives only for the load window would be invisible to a handler-only sample.
    process.env.HARNESS_AMBIENT = "from the host";
    const host = envSnapshot();
    const snapshots: Array<{ where: string; env: Map<string, string | undefined> }> = [];
    const record = (where: string) => () => {
      snapshots.push({ where, env: envSnapshot() });
    };

    try {
      harness = await createHarness({
        extensions: [
          (pi: ExtensionAPI) => {
            record("load")();
            pi.on("session_start", record("session_start"));
            pi.on("before_agent_start", record("before_agent_start"));
          },
        ],
      });
      const current = harness;
      await current.run("hello");

      current.cleanup();
      harness = undefined;
      snapshots.push({ where: "after cleanup", env: envSnapshot() });

      expect(snapshots.map((snapshot) => snapshot.where)).toEqual([
        "load",
        "session_start",
        "before_agent_start",
        "after cleanup",
      ]);
      for (const snapshot of snapshots) {
        expect({ where: snapshot.where, problems: envProblems(host, snapshot.env) }).toEqual({
          where: snapshot.where,
          problems: [],
        });
      }
      expect(existsSync(current.root)).toBe(false);
    } finally {
      delete process.env.HARNESS_AMBIENT;
    }
  });

  test("the cwd and settings options reach the run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "harness-cwd-"));
    let seenCwd: string | undefined;
    let seenDefaultTools: string[] | undefined;
    harness = await createHarness({
      cwd,
      settings: { defaultTools: ["bash"] },
      extensions: [
        (pi: ExtensionAPI) => {
          pi.on("session_start", (_event, ctx) => {
            seenCwd = ctx.cwd;
            seenDefaultTools = pi.getSettings().defaultTools;
          });
        },
      ],
    });
    await harness.run("hello");

    expect(seenCwd).toBe(cwd);
    expect(seenDefaultTools).toEqual(["bash"]);
    rmSync(cwd, { recursive: true, force: true });
  });

  test("an empty response list is refused, and the half-built harness leaves no root", async () => {
    const roots = () => readdirSync(tmpdir()).filter((name) => name.startsWith(HARNESS_ROOT_PREFIX));
    const rootsBefore = roots();
    const failure = await createHarness({ responses: [] }).catch((error: Error) => error.message);
    expect(failure).toContain("at least one scripted response");
    expect(roots()).toEqual(rootsBefore);
  });

  test("cleanup can be called twice", async () => {
    harness = await createHarness({ responses: ["ok"] });
    const current = harness;
    current.cleanup();
    current.cleanup();
    expect(existsSync(current.root)).toBe(false);
  });

  test("two harnesses coexist and clean up independently", async () => {
    const first = await createHarness({ responses: ["first"] });
    const second = await createHarness({ responses: ["second"] });
    try {
      await first.run("hello");
      await second.run("hello");
      expect(first.lastText()).toBe("first");
      expect(second.lastText()).toBe("second");
      expect(first.root).not.toBe(second.root);

      // Cleaning up one must leave the other usable, not just present.
      first.cleanup();
      expect(existsSync(first.root)).toBe(false);
      expect(existsSync(second.root)).toBe(true);
      await second.run("again");
      expect(second.lastText()).toBe("second");
    } finally {
      second.cleanup();
    }
    expect(existsSync(second.root)).toBe(false);
  });

  test("a settings entry cannot load an extension the test did not pass", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-ext-"));
    const leaked = join(dir, "leaked.ts");
    const marker = join(dir, "loaded.txt");
    writeFileSync(
      leaked,
      `import { writeFileSync } from "node:fs";\nexport default function (pi: any) {\n  pi.on("session_start", () => writeFileSync(${JSON.stringify(marker)}, "loaded"));\n}\n`,
    );
    try {
      harness = await createHarness({ settings: { extensions: [leaked] } });
      await harness.run("hello");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("waitForEvent", () => {
  test("resolves an event that already arrived when the caller asks for the log", async () => {
    harness = await createHarness({ responses: ["ok"] });
    await harness.run("hello");
    const event = await harness.waitForEvent((event) => event.type === "agent_settled", { includePast: true });
    expect(event.type).toBe("agent_settled");
  });

  test("ignores an event from an earlier run", async () => {
    harness = await createHarness({ responses: ["ok"] });
    await harness.run("hello");
    const failure = await harness
      .waitForEvent((event) => event.type === "agent_settled", { timeoutMs: 50, description: "a settle" })
      .catch((error: Error) => error.message);
    expect(failure).toContain("waiting for a settle");
  });

  test("rejects instead of hanging when the event never comes", async () => {
    harness = await createHarness({ responses: ["ok"] });
    const failure = await harness
      .waitForEvent((event) => event.type === "auto_retry_start", { timeoutMs: 50, description: "a retry" })
      .catch((error: Error) => error.message);
    expect(failure).toContain("waiting for a retry");
  });
});
