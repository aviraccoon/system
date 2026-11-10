/**
 * The tool_call handler driven through the real extension, one band at a time: with no UI
 * the unattended band decides a confirmation, with a UI the supervised one does, and with
 * `subagent` set the scoped one does and no dialog may open.
 *
 * A real session and a real handler come from the harness. Most cases inject the
 * classifier, because the real one needs a decisions model and a provider key;
 * one runs without the seam to cover the production path. The preference file is
 * injected for the same reason: a test must not read this machine's auto-classify
 * setting.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Harness, HarnessAnswers, ScriptedResponse } from "../shared/testing/session-harness";
import type { ExplanationResult, Mode } from "./logic";

// The suite runs against this machine's `roles.json`; each case sets its own
// `PI_JEV`, provider keys and `PATH` (see isolateEnvironment) and restores them.
const { createHarness } = await import("../shared/testing/session-harness");
const { default: permissionGate } = await import("./index");

const SAFE: ExplanationResult = { verdict: "safe", short: "nothing fired", detail: "" };
const DANGEROUS: ExplanationResult = { verdict: "dangerous", short: "history_rewrite 0.9", detail: "" };

interface Run {
  harness: Harness;
  classifierCalls: string[];
}

/** One verdict for every classified call, or a different one per call. */
type VerdictOption =
  | { verdict: ExplanationResult | null; verdicts?: never }
  /** Consumed in order; the last one repeats. */
  | { verdicts: Array<ExplanationResult | null>; verdict?: never };

type HeadlessOptions = VerdictOption & {
  autoClassify?: "on" | "off";
  /** The saved gate mode; default `careful`. */
  mode?: Mode;
  /** A directory to put first on PATH, for a fake `tirith`. */
  pathPrefix?: string;
  /** Tools to allow in the session; default `["bash"]`. */
  tools?: string[];
  /** Register the gate with no classifier seam, so it must find a backend itself. */
  noSeam?: boolean;
  /** Bind a UI context, so a UI-bound run takes the supervised path, unless `subagent`
   *  makes it `scoped`. An answer set also answers the gate's dialogs. */
  ui?: boolean | HarnessAnswers;
  /** Run the gate as a spawned child sees it: `PI_SUBAGENT=1`, band `scoped`. */
  subagent?: boolean;
  /** Files to create in the session cwd before the run. */
  files?: Record<string, string>;
  responses?: Array<ScriptedResponse | string>;
};

const ONE_CALL: Array<ScriptedResponse | string> = [
  { toolCalls: [{ name: "bash", arguments: { command: "touch out.txt" } }] },
  "done",
];

/** A `tirith` that answers --version and then whatever JSON the case wants from `check`. */
function fakeTirith(json: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fake-tirith-"));
  const fake = join(dir, "tirith");
  writeFileSync(
    fake,
    ["#!/bin/sh", 'if [ "$1" = "--version" ]; then echo "tirith 1.0"; exit 0; fi', `echo '${json}'`, "exit 0"].join(
      "\n",
    ),
  );
  chmodSync(fake, 0o755);
  // Run it once: a cold first exec of a fresh script is what made detection hit
  // its two-second timeout and silently drop the floor on a loaded machine.
  const warm = spawnSync(fake, ["--version"], { encoding: "utf-8" });
  if (warm.status !== 0) throw new Error(`fake tirith did not run: ${warm.stderr}`);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const PROVIDER_KEYS = ["OPENROUTER_API_KEY", "ZAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

/**
 * The gate's own environment: the decisions backend on, the common provider keys
 * gone, and a failing `tirith` first on PATH so an installed one cannot grade a
 * call. The roles file is this machine's; no case may depend on what it names.
 */
function isolateEnvironment(dir: string, pathPrefix?: string, subagent = false): () => void {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A tirith that fails detection, so an installed one cannot grade a call.
  const stub = join(bin, "tirith");
  writeFileSync(stub, "#!/bin/sh\nexit 127\n");
  chmodSync(stub, 0o755);
  const savedPath = process.env.PATH;
  const saved: Record<string, string | undefined> = {};
  for (const key of [...PROVIDER_KEYS, "PI_JEV", "PI_SUBAGENT"]) saved[key] = process.env[key];
  process.env.PATH = [pathPrefix, bin, savedPath].filter(Boolean).join(":");
  process.env.PI_JEV = "on";
  if (subagent) process.env.PI_SUBAGENT = "1";
  else delete process.env.PI_SUBAGENT;
  for (const key of PROVIDER_KEYS) delete process.env[key];
  return () => {
    process.env.PATH = savedPath;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** One headless session; the callback runs before the temp files go away. */
async function headless(options: HeadlessOptions, body: (run: Run) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "permission-gate-headless-"));
  const settingsPath = join(dir, "permission-gate.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ mode: options.mode ?? "careful", autoClassify: options.autoClassify ?? "on" }),
  );
  const classifierCalls: string[] = [];
  const queued = "verdicts" in options && options.verdicts ? [...options.verdicts] : null;
  const restoreEnvironment = isolateEnvironment(dir, options.pathPrefix, options.subagent === true);
  let harness: Harness | undefined;
  try {
    harness = await createHarness({
      ui: options.ui === undefined || options.ui === false ? false : typeof options.ui === "object" ? options.ui : {},
      tools: options.tools ?? ["bash"],
      extensions: [
        (pi) =>
          permissionGate(pi, {
            settingsPath,
            ...(options.noSeam
              ? {}
              : {
                  classifyCall: async (_ctx: unknown, toolName: string) => {
                    classifierCalls.push(toolName);
                    if (!queued) return ("verdict" in options ? options.verdict : null) ?? null;
                    return queued.length > 1 ? (queued.shift() ?? null) : (queued[0] ?? null);
                  },
                }),
          }),
      ],
      responses: options.responses ?? ONE_CALL,
    });
    for (const [name, content] of Object.entries(options.files ?? {})) {
      writeFileSync(join(harness.cwd, name), content);
    }
    await harness.run("create the file");
    body({ harness, classifierCalls });
  } finally {
    harness?.cleanup();
    restoreEnvironment();
    rmSync(dir, { recursive: true, force: true });
  }
}

function resultText(harness: Harness): string {
  const [first] = harness.toolResults();
  return JSON.stringify(first?.result);
}

/** The `classified` entries the gate appended, in order. */
function classifiedEntries(harness: Harness): Array<Record<string, unknown>> {
  return harness.session.sessionManager.getEntries().flatMap((entry) => {
    const custom = entry as { type?: string; customType?: string; data?: Record<string, unknown> };
    if (custom.type !== "custom" || custom.customType !== "permission_gate") return [];
    return custom.data?.event === "classified" ? [custom.data] : [];
  });
}

/** The `denied` entries the gate appended, in order. */
function deniedEntries(harness: Harness): Array<Record<string, unknown>> {
  return harness.session.sessionManager.getEntries().flatMap((entry) => {
    const custom = entry as { type?: string; customType?: string; data?: Record<string, unknown> };
    if (custom.type !== "custom" || custom.customType !== "permission_gate") return [];
    return custom.data?.event === "denied" ? [custom.data] : [];
  });
}

describe("the denial breaker", () => {
  /** A verdict that auto-allows but whose advisory blocks, so the gate refuses by policy. */
  const advisedSafe: ExplanationResult = {
    verdict: "safe",
    short: "nothing fired",
    detail: "",
    advices: { background: 0.9 },
  };
  const blockAnswer = { choice: "Block", note: "", explanation: null };
  /** Four bash calls, then a read of a file the cwd already holds. */
  const fourCalls: Array<ScriptedResponse | string> = [
    { toolCalls: [{ name: "bash", arguments: { command: "touch a.txt" } }] },
    { toolCalls: [{ name: "bash", arguments: { command: "touch b.txt" } }] },
    { toolCalls: [{ name: "bash", arguments: { command: "touch c.txt" } }] },
    { toolCalls: [{ name: "bash", arguments: { command: "touch d.txt" } }] },
    { toolCalls: [{ name: "read", arguments: { path: "note.txt" } }] },
    "done",
  ];
  const readRun = { tools: ["bash", "read"], files: { "note.txt": "hello\n" } };

  test("three denials in a row stop the run, and the next call is never classified", async () => {
    await headless({ verdicts: [DANGEROUS], ...readRun, responses: fourCalls }, ({ harness, classifierCalls }) => {
      expect(existsSync(join(harness.cwd, "a.txt"))).toBe(false);
      expect(
        harness
          .toolResults()
          .slice(0, 4)
          .every((result) => result.isError),
      ).toBe(true);
      expect(JSON.stringify(harness.toolResults()[3]?.result)).toContain("stopped this run");
      // The stopped call is refused before spending a classification.
      expect(classifierCalls).toHaveLength(3);
      expect(deniedEntries(harness).map((entry) => entry.consecutive)).toEqual([1, 2, 3, 3]);
      expect(deniedEntries(harness).at(-1)?.reason).toContain("the run is stopped");
      // The stop ends judgment, not the session: a read still runs, unclassified.
      expect(harness.toolResults()[4]?.isError).toBe(false);
    });
  });

  test("an executed call ends the streak, so three denials spread apart do not stop it", async () => {
    await headless(
      { verdicts: [DANGEROUS, SAFE, DANGEROUS, DANGEROUS], responses: fourCalls },
      ({ harness, classifierCalls }) => {
        expect(existsSync(join(harness.cwd, "b.txt"))).toBe(true);
        expect(classifierCalls).toHaveLength(4);
        expect(deniedEntries(harness).map((entry) => entry.consecutive)).toEqual([1, 1, 2]);
        expect(JSON.stringify(harness.toolResults()[3]?.result)).not.toContain("stopped this run");
      },
    );
  });

  test("a user's block in a dialog is not recorded as a denial and does not count", async () => {
    await headless(
      {
        verdicts: [advisedSafe, DANGEROUS, advisedSafe, advisedSafe],
        ui: { custom: [blockAnswer] },
        responses: fourCalls,
      },
      ({ harness, classifierCalls }) => {
        // Policy denial, user block, policy denial, policy denial: four classified
        // calls, three denials, and the streak never restarts. A blocked call
        // produces no tool result, so it neither counts nor ends the streak.
        expect(deniedEntries(harness).map((entry) => entry.consecutive)).toEqual([1, 2, 3]);
        expect(classifierCalls).toHaveLength(4);
        expect(JSON.stringify(harness.toolResults()[1]?.result)).toContain("BLOCKED by user");
        // The third policy denial is the one that trips; the block never counted.
        expect(JSON.stringify(harness.toolResults()[3]?.result)).toContain("3 consecutive denials");
      },
    );
  });

  test("a stopped refusal repeats the streak that tripped, even after a read ran", async () => {
    const tirith = fakeTirith(
      '{"action":"block","findings":[{"severity":"CRITICAL","rule_id":"fake-rule","title":"fake finding","description":"x"}]}',
    );
    try {
      await headless(
        {
          verdicts: [DANGEROUS],
          pathPrefix: tirith.dir,
          ...readRun,
          responses: [
            { toolCalls: [{ name: "bash", arguments: { command: "touch a.txt" } }] },
            { toolCalls: [{ name: "bash", arguments: { command: "touch b.txt" } }] },
            { toolCalls: [{ name: "bash", arguments: { command: "touch c.txt" } }] },
            { toolCalls: [{ name: "read", arguments: { path: "note.txt" } }] },
            { toolCalls: [{ name: "bash", arguments: { command: "touch d.txt" } }] },
            "done",
          ],
        },
        ({ harness }) => {
          // Three CRITICAL-floored refusals trip the stop; the read then runs and resets
          // the live counter, so the stopped refusal must log the trip's streak, not zero.
          expect(deniedEntries(harness).map((entry) => entry.consecutive)).toEqual([1, 2, 3, 3]);
          const stopped = JSON.stringify(harness.toolResults()[4]?.result);
          expect(stopped).toContain("the run is stopped");
          // A stopped refusal still carries the evidence that made the call risky.
          expect(stopped).toContain("fake finding");
        },
      );
    } finally {
      tirith.cleanup();
    }
  });

  test("a tripped stop tells the user once", async () => {
    await headless({ verdicts: [advisedSafe], ui: {}, responses: fourCalls }, ({ harness, classifierCalls }) => {
      expect(classifierCalls).toHaveLength(3);
      expect(deniedEntries(harness).map((entry) => entry.consecutive)).toEqual([1, 2, 3, 3]);
      const warnings = (harness.ui?.notifications ?? []).filter((note) => note.message.includes("stopped this run"));
      expect(warnings).toHaveLength(1);
    });
  });
});

describe("a subagent", () => {
  const write = (path: string) => ({
    toolCalls: [{ name: "write", arguments: { path, content: "x\n" } }],
  });
  const risky = [
    { verdict: "risky" as const, short: "mutates_state 0.90", detail: "", factors: { mutates_state: 0.9 } },
  ];
  const child = { subagent: true, ui: {}, tools: ["bash", "write"] };

  test("a write inside its cwd runs under the scoped band, with no dialog", async () => {
    await headless({ verdicts: risky, ...child, responses: [write("in.txt"), "done"] }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "in.txt"))).toBe(true);
      expect(harness.ui?.dialogs).toEqual([]);
      expect(classifiedEntries(harness).map((entry) => entry.band)).toEqual(["scoped"]);
    });
  });

  test("a write outside its cwd is refused with the scope reason, and still no dialog", async () => {
    await headless({ verdicts: risky, ...child, responses: [write("../outside.txt"), "done"] }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "..", "outside.txt"))).toBe(false);
      expect(resultText(harness)).toContain("outside the run's scope");
      expect(harness.ui?.dialogs).toEqual([]);
      expect(deniedEntries(harness).map((entry) => entry.band)).toEqual(["scoped"]);
    });
  });

  test("a risky shell call is refused, since no path check can bound a shell", async () => {
    await headless(
      {
        verdicts: [{ verdict: "risky", short: "runs_local_code 0.90", detail: "", factors: { runs_local_code: 0.9 } }],
        ...child,
        responses: ONE_CALL,
      },
      ({ harness }) => {
        expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
        expect(resultText(harness)).toContain("not confined to the run's scope");
        expect(harness.ui?.dialogs).toEqual([]);
      },
    );
  });

  test("a risky shell carrying an in-scope path is still refused", async () => {
    // A shell borrows nothing from a `path` field: what bounds it is the sandbox.
    await headless(
      {
        verdicts: [{ verdict: "risky", short: "runs_local_code 0.90", detail: "", factors: { runs_local_code: 0.9 } }],
        ...child,
        responses: [
          { toolCalls: [{ name: "bash", arguments: { command: "touch out.txt", path: "out.txt" } }] },
          "done",
        ],
      },
      ({ harness }) => {
        expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
        expect(resultText(harness)).toContain("not confined to the run's scope");
        expect(harness.ui?.dialogs).toEqual([]);
      },
    );
  });

  test("a path target outside the scope is refused whatever the verdict says", async () => {
    // A write is an effect even when the classifier calls it safe, so the scope fact is
    // read before the safe allow.
    await headless(
      {
        verdicts: [{ verdict: "safe", short: "nothing fired", detail: "" }],
        ...child,
        responses: [write("../outside.txt"), "done"],
      },
      ({ harness }) => {
        expect(existsSync(join(harness.cwd, "..", "outside.txt"))).toBe(false);
        expect(resultText(harness)).toContain("outside the run's scope");
        expect(harness.ui?.dialogs).toEqual([]);
      },
    );
  });

  test("a safe shell call runs, since a safe verdict has no effect to confine", async () => {
    // Scope bounds what a call *changes*; a safe shell changes nothing. The sandbox, not
    // this band, is what bounds a shell that does.
    await headless({ verdict: SAFE, ...child, responses: ONE_CALL }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(true);
      expect(harness.ui?.dialogs).toEqual([]);
    });
  });

  test("with no classifier it refuses instead of asking", async () => {
    await headless({ verdict: SAFE, ...child, autoClassify: "off", responses: ONE_CALL }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
      expect(resultText(harness)).toContain("non-interactive mode");
      expect(harness.ui?.dialogs).toEqual([]);
    });
  });
});

describe("a call with no dialog", () => {
  test("a safe verdict runs the call", async () => {
    await headless({ verdict: SAFE }, ({ harness, classifierCalls }) => {
      expect(classifierCalls).toEqual(["bash"]);
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(true);
      expect(harness.toolResults()[0]?.isError).toBe(false);
    });
  });

  test("a dangerous verdict blocks, names the factor and records the verdict", async () => {
    await headless({ verdict: DANGEROUS }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
      expect(harness.toolResults()[0]?.isError).toBe(true);
      expect(resultText(harness)).toContain("history_rewrite 0.9");
      // A blocked call leaves nothing else: the entry is the record of what the
      // classifier said about it, including which policy gave the answer.
      expect(classifiedEntries(harness)).toEqual([
        expect.objectContaining({ verdict: "dangerous", mode: "careful", band: "unattended" }),
      ]);
    });
  });

  test("with a UI bound, the entry records the supervised band and the session mode", async () => {
    await headless({ verdict: SAFE, ui: true, mode: "trust-project" }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(true);
      expect(classifiedEntries(harness)).toEqual([
        expect.objectContaining({ verdict: "safe", mode: "trust-project", band: "supervised" }),
      ]);
    });
  });

  test("a missing verdict blocks instead of allowing", async () => {
    await headless({ verdict: null }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
      expect(resultText(harness)).toContain("no risk classification was available");
    });
  });

  test("an advisory that blocks on an allowed verdict still blocks", async () => {
    const advised: ExplanationResult = { ...SAFE, advices: { advice: 0.9 } };
    await headless({ verdict: advised }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
      expect(resultText(harness)).toContain("output-capture");
    });
  });

  test("the backgrounding advisory blocks an allowed call and names the foreground rewrite", async () => {
    const advised: ExplanationResult = { ...SAFE, advices: { background: 0.9 } };
    await headless({ verdict: advised }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
      expect(resultText(harness)).toContain("background: this call was blocked");
      expect(resultText(harness)).toContain("foreground");
    });
  });

  test("the patch reminder rides the result of a call the verdict allowed", async () => {
    const reminded: ExplanationResult = { ...SAFE, advices: { patch: 0.9 } };
    await headless({ verdict: reminded }, ({ harness }) => {
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(true);
      // recordClassification is what stages this note; without it the model never learns.
      expect(resultText(harness)).toContain("patch tool refuses an unmatched edit");
    });
  });

  test("a credential path is refused by the floor without classifying anything", async () => {
    const call = { toolCalls: [{ name: "write", arguments: { path: ".ssh/id_ed25519", content: "x" } }] };
    await headless(
      { verdict: SAFE, tools: ["bash", "write"], responses: [call, "done"] },
      ({ harness, classifierCalls }) => {
        expect(classifierCalls).toEqual([]);
        expect(resultText(harness)).toContain("credential");
        expect(existsSync(join(harness.cwd, ".ssh", "id_ed25519"))).toBe(false);
      },
    );
  });

  test("a repeated call reuses the verdict instead of classifying twice", async () => {
    const call = { toolCalls: [{ name: "bash", arguments: { command: "touch out.txt" } }] };
    await headless({ verdict: SAFE, responses: [call, call, "done"] }, ({ harness, classifierCalls }) => {
      expect(classifierCalls).toEqual(["bash"]);
      expect(harness.toolResults()[0]?.isError).toBe(false);
    });
  });

  test("a tirith floor blocks a safe verdict and skips the classifier", async () => {
    const tirith = fakeTirith(
      '{"action":"block","findings":[{"severity":"CRITICAL","rule_id":"fake-rule","title":"fake finding","description":"x"}]}',
    );
    try {
      await headless({ verdict: SAFE, pathPrefix: tirith.dir }, ({ harness, classifierCalls }) => {
        expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
        expect(resultText(harness)).toContain("fake finding");
        expect(classifierCalls).toEqual([]);
      });
    } finally {
      tirith.cleanup();
    }
  });

  test("a tirith warning rides the result of a call the verdict allowed", async () => {
    const tirith = fakeTirith(
      '{"action":"warn","findings":[{"severity":"WARN","rule_id":"fake-rule","title":"fake finding","description":"x"}]}',
    );
    try {
      await headless({ verdict: SAFE, pathPrefix: tirith.dir }, ({ harness }) => {
        expect(existsSync(join(harness.cwd, "out.txt"))).toBe(true);
        // The only channel a headless run has for a non-CRITICAL finding.
        expect(resultText(harness)).toContain("fake-rule");
      });
    } finally {
      tirith.cleanup();
    }
  });

  test("without a test seam the gate still finds the backend session_start reported", async () => {
    // A credential path is refused by the floor before any verdict is wanted, so
    // the reason is the floor's only when the policy saw a classifier: the frozen
    // constant this replaced (read at factory time) yields the blanket block
    // instead. No classifier runs, so no role or provider key can decide this.
    const call = { toolCalls: [{ name: "write", arguments: { path: ".ssh/id_ed25519", content: "x" } }] };
    await headless(
      { verdict: null, noSeam: true, tools: ["bash", "write"], responses: [call, "done"] },
      ({ harness }) => {
        expect(resultText(harness)).toContain("credential");
        expect(existsSync(join(harness.cwd, ".ssh", "id_ed25519"))).toBe(false);
      },
    );
  });

  test("with auto-classify off the blanket block stands and no classifier runs", async () => {
    await headless({ verdict: SAFE, autoClassify: "off" }, ({ harness, classifierCalls }) => {
      expect(classifierCalls).toEqual([]);
      expect(existsSync(join(harness.cwd, "out.txt"))).toBe(false);
      expect(resultText(harness)).toContain("blocked in non-interactive mode");
    });
  });
});
