import { describe, expect, test } from "bun:test";
import type { ParsedCli } from "../../../../shared/cli";
import type { BenchRow } from "./calibrate";
import {
  benchReport,
  CLI,
  calibrationFromBench,
  calibrationReport,
  chooseOne,
  cliInput,
  formatReport,
  labelRefusals,
  logReport,
  projectsIn,
  readBenchDump,
  suggestThreshold,
} from "./calibrate";
import type { GuardDecision } from "./decisions";

const AT = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 12, minutes)).toISOString();

function record(overrides: Partial<GuardDecision> = {}): GuardDecision {
  return {
    at: AT(0),
    session: "s-1",
    project: "acme-widgets",
    kind: "policy",
    command: "pnpm install",
    tool: "bash",
    violated: true,
    clause: "deps",
    probability: 0.9,
    threshold: 0.65,
    scores: { deps: 0.9 },
    missing: [],
    ...overrides,
  };
}

/** An unlock record, with the surface it covers: `/guard allow` is bash, `/guard off` is all. */
const unlock = (at: string, command = "/guard allow") =>
  record({
    at,
    kind: "unlock",
    command,
    tool: command === "/guard off" ? "*" : "bash",
    violated: false,
    clause: null,
    scores: {},
  });

describe("labelRefusals", () => {
  test("an unlock soon after a refusal marks it overridden", () => {
    const labeled = labelRefusals([record({ at: AT(0) }), unlock(AT(2))]);
    expect(labeled).toEqual([{ clause: "deps", score: 0.9, label: "overridden" }]);
  });

  test("/guard off labels too, since it is the unlock a non-shell refusal names", () => {
    const labeled = labelRefusals([record({ at: AT(0) }), unlock(AT(1), "/guard off")]);
    expect(labeled).toEqual([{ clause: "deps", score: 0.9, label: "overridden" }]);
  });

  test("a host grant does not label a refusal it cannot unlock, while /guard off does", () => {
    // A host grant covers bash only, so a refused write is still refused after it.
    const write = record({ at: AT(0), tool: "write", command: "app/a.ts" });
    expect(labelRefusals([write, unlock(AT(1))])).toEqual([]);
    expect(labelRefusals([write, unlock(AT(1), "/guard off")])).toHaveLength(1);
  });

  test("a refusal recorded without a tool is not labelled by a host grant", () => {
    expect(labelRefusals([record({ at: AT(0), tool: "" }), unlock(AT(1))])).toEqual([]);
    expect(labelRefusals([record({ at: AT(0), tool: "" }), unlock(AT(1), "/guard off")])).toHaveLength(1);
  });

  test("two records without a tool do not cover each other", () => {
    // An unlock written before `tool` existed carries none, so it cannot say what it unlocked.
    const oldUnlock = record({
      at: AT(1),
      kind: "unlock",
      command: "/guard allow",
      tool: "",
      violated: false,
      clause: null,
    });
    expect(labelRefusals([record({ at: AT(0), tool: "" }), oldUnlock])).toEqual([]);
  });

  test("an unlock outside the window does not label the refusal", () => {
    expect(labelRefusals([record({ at: AT(0) }), unlock(AT(30))], { overrideWindowMs: 60_000 })).toEqual([]);
  });

  test("another judged call between the refusal and the unlock takes the label", () => {
    const labeled = labelRefusals([
      record({ at: AT(0) }),
      record({ at: AT(1), command: "git status", violated: false, clause: null, scores: { deps: 0.1 } }),
      unlock(AT(2)),
    ]);
    // The cleared retry answers the refusal; the unlock answers that one.
    expect(labeled).toEqual([{ clause: "deps", score: 0.9, label: "stood" }]);
  });

  test("a floor refusal between a refusal and an unlock takes the answer", () => {
    // The unlock answered the floor refusal, not the policy one before it.
    const labeled = labelRefusals([
      record({ at: AT(0) }),
      record({ at: AT(1), kind: "policy-shell", command: ".agents/policy.json", clause: null, scores: {} }),
      unlock(AT(2), "/guard off"),
    ]);
    expect(labeled).toEqual([]);
  });

  test("a refusal the agent accepted stood", () => {
    const labeled = labelRefusals([
      record({ at: AT(0) }),
      record({ at: AT(3), command: "docker exec acme-dev-1 pnpm install", violated: false, clause: null }),
    ]);
    expect(labeled).toEqual([{ clause: "deps", score: 0.9, label: "stood" }]);
  });

  test("a refusal whose verdict came from part of the policy carries no label", () => {
    // The judge did not answer every clause, so its verdict is not evidence about this one.
    expect(labelRefusals([record({ at: AT(0), missing: ["e2e"] }), unlock(AT(1))])).toEqual([]);
  });

  test("labels are scoped to the session that answered", () => {
    expect(labelRefusals([record({ at: AT(0) }), unlock(AT(1))])).toHaveLength(1);
    // An unlock in another window cannot answer this session's refusal.
    expect(labelRefusals([record({ at: AT(0), session: "s-1" }), { ...unlock(AT(1)), session: "s-2" }])).toEqual([]);
  });

  test("a refusal with no clause, or a floor refusal, carries no label", () => {
    expect(labelRefusals([record({ clause: null }), unlock(AT(1))])).toEqual([]);
    expect(labelRefusals([record({ kind: "policy-write", clause: null }), unlock(AT(1))])).toEqual([]);
  });

  test("a record with no score for its clause is scored by its probability", () => {
    const old = record({ scores: {}, probability: 0.72 });
    expect(labelRefusals([old, unlock(AT(1))])).toEqual([{ clause: "deps", score: 0.72, label: "overridden" }]);
  });
});

describe("suggestThreshold", () => {
  test("too few labels of either class is reported by count, not guessed", () => {
    expect(suggestThreshold([0.9, 0.8], [0.1], 5)).toEqual({
      suggested: null,
      note: "needs 5 labels of each class, has 2 standing and 1 overridden",
    });
  });

  test("separated labels give the unrounded midpoint", () => {
    const fit = suggestThreshold([0.9, 0.85, 0.8, 0.75, 0.7], [0.4, 0.3, 0.2, 0.1, 0.05]);
    expect(fit.suggested).toBe(0.55);
    // Three decimals here too, so the note cannot print a score the threshold just cleared.
    expect(fit.note).toContain("standing refusals from 0.700");
    expect(fit.note).toContain("overridden ones up to 0.400");
  });

  test("the midpoint stays above the highest overridden score even when rounding would not", () => {
    const fit = suggestThreshold([0.704, 0.75, 0.8, 0.85, 0.9], [0.7, 0.2, 0.3, 0.4, 0.5], 5);
    expect(fit.suggested).toBe(0.702);
    expect(fit.suggested).toBeGreaterThan(0.7);
  });

  test("overlapping labels give no threshold, and name both sides", () => {
    const fit = suggestThreshold([0.7, 0.8, 0.9, 0.95, 0.99], [0.6, 0.65, 0.7, 0.75, 0.8]);
    expect(fit.suggested).toBeNull();
    expect(fit.note).toContain("overlap");
    expect(fit.note).toContain("a refusal that stood scores 0.700");
    expect(fit.note).toContain("an overridden one 0.800");
  });
});

describe("calibrationReport", () => {
  test("counts judged and cited calls per clause, and folds in the labels", () => {
    const decisions = [
      record({ at: AT(0) }),
      record({ at: AT(1), command: "git status", violated: false, clause: null, scores: { deps: 0.1, e2e: 0.7 } }),
      unlock(AT(2)),
    ];
    const reports = calibrationReport(decisions, "acme-widgets");
    expect(reports.map((entry) => entry.clause)).toEqual(["deps", "e2e"]);
    expect(reports[0]).toMatchObject({ judged: 2, cited: 1, stood: 1, overridden: 0 });
    expect(reports[0]?.suggested).toBeNull();
    expect(reports[0]?.note).toContain("needs 5 labels");
  });

  test("a record with no score for its cited clause still counts it as judged", () => {
    const reports = calibrationReport([record({ scores: {}, probability: 0.8 })], "acme-widgets");
    expect(reports[0]).toMatchObject({ clause: "deps", judged: 1, cited: 1 });
  });

  test("a clause no record scored is absent rather than reported empty", () => {
    expect(calibrationReport([], "acme-widgets")).toEqual([]);
  });

  test("another project's records do not fit this project's clause", () => {
    // A clause id means a different rule in each project, so the fit reads one project.
    const decisions = [
      record({ at: AT(0) }),
      unlock(AT(1)),
      record({ at: AT(0), project: "other-project", scores: { deps: 0.4 } }),
      unlock(AT(1), "/guard off"),
    ];
    const reports = calibrationReport(decisions, "acme-widgets");
    expect(reports).toHaveLength(1);
    // The other project's 0.4 score is not the highest overridden one in this project.
    expect(reports[0]).toMatchObject({ clause: "deps", judged: 1, stood: 0, overridden: 1 });
    expect(reports[0]?.highestOverridden).toBe(0.9);
  });

  test("a record with no project name is not fitted", () => {
    expect(calibrationReport([record({ project: "" })], "")).toEqual([]);
  });
});

describe("calibrationFromBench", () => {
  const row = (
    over: Partial<{
      id: string;
      policy: string;
      expected: boolean;
      expectedClause: string | null;
      scores: Record<string, number>;
    }> = {},
  ) => ({
    id: "case",
    policy: "short",
    expected: true,
    expectedClause: "deps",
    scores: {},
    ...over,
  });

  test("standing refusals are the cases that should cite the clause, overridden ones the allowed cases", () => {
    const rows = [
      row({ id: "a", scores: { deps: 0.9 } }),
      row({ id: "b", scores: { deps: 0.8 } }),
      row({ id: "c", expected: false, expectedClause: null, scores: { deps: 0.1 } }),
      row({ id: "d", expected: false, expectedClause: null, scores: { deps: 0.2 } }),
    ];
    const deps = calibrationFromBench(rows, { minLabels: 2 }).find((report) => report.clause === "deps");
    expect(deps).toMatchObject({ stood: 2, overridden: 2, lowestStood: 0.8, highestOverridden: 0.2 });
    expect(deps?.suggested).toBe(0.5);
  });

  test("a clause the benchmark never expects to cite gets no threshold", () => {
    const rows = [row({ expected: false, expectedClause: null, scores: { deps: 0.1, e2e: 0.9 } })];
    expect(calibrationFromBench(rows, { minLabels: 1 }).find((r) => r.clause === "e2e")?.suggested).toBeNull();
  });
});

describe("readBenchDump", () => {
  test("reads policy runs, skips other kinds and unparsable lines", () => {
    const dump = [
      "{not json",
      JSON.stringify({ kind: "contamination", rows: [{ id: "x", expected: true }] }),
      JSON.stringify({
        kind: "policy",
        policy: "short",
        rows: [{ id: "a", expected: true, expectedClause: "deps", scores: { deps: 0.9 } }],
      }),
      JSON.stringify({
        kind: "policy",
        policy: "long",
        rows: [{ id: "a", expected: true, expectedClause: "deps", scores: { deps: 0.95 } }],
      }),
    ].join("\n");
    const read = readBenchDump(dump);
    expect(read.policies).toEqual(["long", "short"]);
    expect(read.rows).toHaveLength(2);
    expect(read.rows.map((row) => row.policy)).toEqual(["short", "long"]);
  });

  test("a dump for one policy is selected by name", () => {
    const dump = [
      JSON.stringify({ kind: "policy", policy: "short", rows: [] }),
      JSON.stringify({ kind: "policy", policy: "long", rows: [{ id: "a", expected: true, scores: {} }] }),
    ].join("\n");
    expect(readBenchDump(dump, "long").rows).toHaveLength(1);
    expect(readBenchDump(dump, "short").rows).toEqual([]);
  });

  test("a row with no id or expectation is dropped, and one with no scores is kept", () => {
    const dump = JSON.stringify({
      kind: "policy",
      policy: "short",
      rows: [{ id: "a", expected: true }, { expected: true }, { id: "b", expected: false, scores: { deps: "0.9" } }],
    });
    const read = readBenchDump(dump);
    expect(read.rows.map((row) => row.id)).toEqual(["a", "b"]);
    // A row without scores scores nothing for any clause, so it feeds no class.
    expect(read.rows[0]?.scores).toEqual({});
    // A score that is not a number is dropped, as the log reader drops it.
    expect(read.rows[1]?.scores).toEqual({});
  });
});

describe("formatReport", () => {
  test("says there is nothing to calibrate when no call was judged", () => {
    expect(formatReport([], "no judged calls in the log yet: nothing to calibrate")).toEqual([
      "no judged calls in the log yet: nothing to calibrate",
    ]);
  });

  test("says a dump carries no scores rather than speaking of the log", () => {
    expect(formatReport([], "no clause scores in this dump: nothing to calibrate")).toEqual([
      "no clause scores in this dump: nothing to calibrate",
    ]);
  });

  test("prints the counts, the threshold and the reason", () => {
    const lines = formatReport([
      {
        clause: "deps",
        judged: 12,
        cited: 6,
        stood: 5,
        overridden: 5,
        lowestStood: 0.7,
        highestOverridden: 0.4,
        suggested: 0.55,
        note: "standing refusals from 0.70, overridden ones up to 0.40",
      },
    ]);
    expect(lines[0]).toContain("deps: 12 judged, 6 cited, 5 stood, 5 overridden");
    expect(lines[0]).toContain("threshold 0.550");
  });

  test("prints the suggestion to three decimals, since the midpoint is unrounded", () => {
    const lines = formatReport([
      {
        clause: "deps",
        judged: 10,
        cited: 5,
        stood: 5,
        overridden: 5,
        lowestStood: 0.704,
        highestOverridden: 0.7,
        suggested: 0.702,
        note: "standing refusals from 0.70, overridden ones up to 0.70",
      },
    ]);
    expect(lines[0]).toContain("threshold 0.702");
  });
});

describe("logReport", () => {
  test("an empty log says nothing was judged, and reads no records", () => {
    const report = logReport([], "acme-widgets", "/tmp/log");
    expect(report.lines).toEqual(["no judged calls in the log yet: nothing to calibrate"]);
    expect(report.footer).toBe("0 records read from /tmp/log (acme-widgets)");
  });

  test("a project whose records carry no scores is not reported as an empty log", () => {
    const floor = record({ kind: "policy-write", clause: null, scores: {} });
    const report = logReport([floor], "acme-widgets", "/tmp/log");
    expect(report.lines).toEqual(["no clause scores in this project's records: nothing to calibrate"]);
    expect(report.footer).toBe("1 record read from /tmp/log (acme-widgets)");
  });

  test("the fit and the footer name the project that was read", () => {
    const report = logReport([record(), record({ project: "zeta" })], "zeta", "/tmp/log");
    expect(report.footer).toBe("1 record read from /tmp/log (zeta)");
    expect(report.lines[0]).toContain("deps:");
  });
});

describe("benchReport", () => {
  const row = (over: Partial<BenchRow> = {}): BenchRow => ({
    id: "a",
    policy: "short",
    expected: true,
    expectedClause: "deps",
    scores: { deps: 0.9 },
    ...over,
  });

  test("names the rows and their source, with the hand-label caveat", () => {
    const report = benchReport([row()], "/tmp/dump", "short");
    expect(report.footer).toContain("1 benchmark row read from /tmp/dump (short)");
    expect(report.footer).toContain("hand label");
    expect(benchReport([row(), row()], "/tmp/dump", "short").footer).toContain("2 benchmark rows");
  });

  test("a row without scores scores nothing for any clause", () => {
    expect(benchReport([row({ scores: {} })], "/tmp/dump", "short").lines).toEqual([
      "no clause scores in this dump: nothing to calibrate",
    ]);
  });
});

describe("projectsIn", () => {
  test("names each project once, sorted, and leaves out a record with none", () => {
    const decisions = [
      record({ project: "zeta" }),
      record({ project: "acme-widgets" }),
      record({ project: "" }),
      record({ project: "zeta" }),
    ];
    expect(projectsIn(decisions)).toEqual(["acme-widgets", "zeta"]);
  });
});

const POLICY_TERMS = { one: "policy", many: "policies" };
const PROJECT_TERMS = { one: "project", many: "projects" };

describe("chooseOne", () => {
  test("one name needs no choice", () => {
    expect(chooseOne(["short"], undefined, POLICY_TERMS, "--policy")).toEqual({ name: "short" });
  });

  test("several names are refused by name, so nothing is pooled", () => {
    expect(chooseOne(["long", "short"], undefined, POLICY_TERMS, "--policy")).toEqual({
      error: "2 policies (long, short); pass --policy <name>",
    });
    expect(chooseOne(["acme-widgets", "zeta"], undefined, PROJECT_TERMS, "--project")).toEqual({
      error: "2 projects (acme-widgets, zeta); pass --project <name>",
    });
  });

  test("a named one is used, whether the file carries it or not", () => {
    expect(chooseOne(["long", "short"], "long", POLICY_TERMS, "--policy")).toEqual({ name: "long" });
    expect(chooseOne(["long", "short"], "other", POLICY_TERMS, "--policy")).toEqual({
      error: 'no policy "other" (has: long, short)',
    });
  });

  test("an empty file names nothing, which fits no records", () => {
    expect(chooseOne([], undefined, PROJECT_TERMS, "--project")).toEqual({ name: "" });
    // With no name to check, a request is taken and the caller reports the empty file.
    expect(chooseOne([], "acme-widgets", PROJECT_TERMS, "--project")).toEqual({ name: "acme-widgets" });
  });
});

describe("CLI", () => {
  test("takes at most one path, so a second one is not silently ignored", () => {
    expect(CLI.arity).toEqual({ min: 0, max: 1 });
    expect(CLI.args).toBe("[path]");
  });
});

describe("cliInput", () => {
  const parsed = (over: Partial<ParsedCli> = {}): ParsedCli => ({
    commandPath: [],
    positionals: [],
    args: [],
    values: {},
    help: false,
    ...over,
  });

  test("a lone argument is the file to read, since a flag's value is not in args", () => {
    expect(cliInput(parsed({ args: ["/tmp/log.jsonl"] }), "/default").path).toBe("/tmp/log.jsonl");
  });

  test("the flags and the path are read from one parse", () => {
    expect(
      cliInput(
        parsed({ args: ["/tmp/dump.jsonl"], values: { bench: true, policy: "short", project: "acme-widgets" } }),
        "/default",
      ),
    ).toEqual({ bench: true, policy: "short", project: "acme-widgets", path: "/tmp/dump.jsonl" });
  });

  test("no path means the default log, and no flags means the log itself", () => {
    expect(cliInput(parsed(), "/default")).toEqual({
      bench: false,
      policy: undefined,
      project: undefined,
      path: "/default",
    });
  });
});
