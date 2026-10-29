import { describe, expect, test } from "bun:test";
import { clock, formatHm, localDay, renderJson, renderText, shiftDay, zonedEpoch } from "./format";
import { type Deps, discoverFiles, parseCli, run } from "./session-span";
import { activeMinutes, buildReport, findGaps, groupLineages, parseSessionFile, type SessionRow } from "./sessions";

// ---------- fixtures ----------

interface RowOptions {
  role?: string;
  durationMs?: number;
  toolCalls?: string[];
  toolCallId?: string;
}

function row(id: string, iso: string, opts: RowOptions = {}): string {
  const message: Record<string, unknown> = { role: opts.role ?? "assistant" };
  if (opts.durationMs !== undefined) message.durationMs = opts.durationMs;
  if (opts.toolCallId !== undefined) message.toolCallId = opts.toolCallId;
  if (opts.toolCalls !== undefined) {
    message.content = opts.toolCalls.map((callId) => ({ type: "toolCall", id: callId, name: "bash" }));
  }
  return JSON.stringify({ type: "message", id, timestamp: iso, message });
}

function sessionFile(rows: string[], opts: { cwd?: string; version?: number } = {}): string {
  const header = JSON.stringify({
    type: "session",
    version: opts.version ?? 3,
    id: "session-header",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: opts.cwd ?? "/home/example/app",
  });
  return `${[header, ...rows].join("\n")}\n`;
}

function memoryDeps(files: Record<string, string>, opts: { now?: string } = {}): Deps {
  const root = "root";
  const dirs = [...new Set(Object.keys(files).map((path) => path.split("/")[1] ?? ""))];
  return {
    listDirs: () => dirs,
    listFiles: (dir) =>
      Object.keys(files)
        .filter((path) => path.startsWith(`${dir}/`))
        .map((path) => path.slice(dir.length + 1)),
    readFile: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file ${path}`);
      return content;
    },
    now: new Date(opts.now ?? "2026-01-01T12:00:00.000Z"),
    sessionRoot: root,
    timeZone: "UTC",
  };
}

// ---------- parseSessionFile ----------

describe("parseSessionFile", () => {
  test("reads header, roles, durations, and tool-call pairing", () => {
    const content = sessionFile(
      [
        row("a1", "2026-01-01T00:00:00.000Z", { role: "user" }),
        row("a2", "2026-01-01T00:00:05.000Z", { durationMs: 5000, toolCalls: ["call_1", "call_2"] }),
        row("a3", "2026-01-01T00:00:09.000Z", { role: "toolResult", toolCallId: "call_1", durationMs: 4000 }),
      ],
      { cwd: "/home/example/other" },
    );

    const file = parseSessionFile("f.jsonl", content);

    expect(file.cwd).toBe("/home/example/other");
    expect(file.rows).toHaveLength(3);
    expect(file.rows[1]).toMatchObject({ durationMs: 5000, toolCallIds: ["call_1", "call_2"] });
    expect(file.rows[2]).toMatchObject({ role: "toolResult", toolCallId: "call_1" });
  });

  test("rejects an unknown session version", () => {
    const content = sessionFile([row("a1", "2026-01-01T00:00:00.000Z")], { version: 4 });

    expect(() => parseSessionFile("f.jsonl", content)).toThrow(/version 4/);
  });

  test("rejects a file without a session header", () => {
    expect(() => parseSessionFile("f.jsonl", row("a1", "2026-01-01T00:00:00.000Z"))).toThrow(/no session header/);
  });

  test("rejects malformed lines and rows without a timestamp", () => {
    expect(() => parseSessionFile("f.jsonl", `${sessionFile([], {})}{"broken"`)).toThrow(/not JSON/);
    const noTimestamp = `${sessionFile([], {})}${JSON.stringify({ type: "message", id: "x", message: {} })}`;
    expect(() => parseSessionFile("f.jsonl", noTimestamp)).toThrow(/without timestamp/);
  });
});

// ---------- groupLineages ----------

describe("groupLineages", () => {
  const parse = (label: string, rows: string[]) => parseSessionFile(label, sessionFile(rows));

  test("merges a rotated replay into one lineage and dedupes rows", () => {
    const first = parse("a.jsonl", [row("a1", "2026-01-01T00:00:00.000Z"), row("a2", "2026-01-01T00:10:00.000Z")]);
    const second = parse("b.jsonl", [row("a2", "2026-01-01T00:10:00.000Z"), row("b1", "2026-01-01T00:20:00.000Z")]);

    const lineages = groupLineages([first, second]);

    expect(lineages).toHaveLength(1);
    expect(lineages[0]?.files).toEqual(["a.jsonl", "b.jsonl"]);
    expect(lineages[0]?.rows.map((r) => r.id)).toEqual(["a1", "a2", "b1"]);
  });

  test("keeps unrelated sessions apart", () => {
    const first = parse("a.jsonl", [row("a1", "2026-01-01T00:00:00.000Z")]);
    const second = parse("b.jsonl", [row("b1", "2026-01-01T01:00:00.000Z")]);

    expect(groupLineages([first, second])).toHaveLength(2);
  });

  test("bridges lineages transitively through a shared file", () => {
    const a = parse("a.jsonl", [row("a1", "2026-01-01T00:00:00.000Z"), row("x", "2026-01-01T00:01:00.000Z")]);
    const b = parse("b.jsonl", [row("x", "2026-01-01T00:01:00.000Z"), row("y", "2026-01-01T00:02:00.000Z")]);
    const c = parse("c.jsonl", [row("y", "2026-01-01T00:02:00.000Z"), row("c1", "2026-01-01T00:03:00.000Z")]);

    const lineages = groupLineages([a, b, c]);

    expect(lineages).toHaveLength(1);
    expect(lineages[0]?.files).toEqual(["a.jsonl", "b.jsonl", "c.jsonl"]);
  });
});

// ---------- findGaps ----------

describe("findGaps", () => {
  const make = (id: string, iso: string, opts: RowOptions = {}): SessionRow => {
    const parsed = parseSessionFile("f.jsonl", sessionFile([row(id, iso, opts)]));
    const parsedRow = parsed.rows[0];
    if (!parsedRow) throw new Error("fixture row missing");
    return parsedRow;
  };

  test("flags an unexplained gap at the idle threshold", () => {
    const gaps = findGaps([
      make("a", "2026-01-01T00:00:00.000Z", { role: "user" }),
      make("b", "2026-01-01T00:20:00.000Z", { role: "user" }),
    ]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "idle", minutes: 20, evidence: null });
  });

  test("credits the operation the row after the gap reports", () => {
    const gaps = findGaps([
      make("a", "2026-01-01T00:00:00.000Z", { role: "user" }),
      make("b", "2026-01-01T00:10:00.000Z", { durationMs: 570_000 }),
    ]);

    expect(gaps[0]).toMatchObject({ kind: "work", evidence: "op 9.5 min" });
  });

  test("ignores a duration recorded before the gap", () => {
    const gaps = findGaps([
      make("a", "2026-01-01T00:00:00.000Z", { durationMs: 1_140_000 }),
      make("b", "2026-01-01T00:20:00.000Z", { role: "user" }),
    ]);

    expect(gaps[0]).toMatchObject({ kind: "idle", evidence: null });
  });

  test("credits the run of a tool call the previous row emitted", () => {
    const gaps = findGaps([
      make("a", "2026-01-01T00:00:00.000Z", { toolCalls: ["call_1"] }),
      make("b", "2026-01-01T00:20:00.000Z", { role: "toolResult", toolCallId: "call_1", durationMs: 1000 }),
    ]);

    expect(gaps[0]).toMatchObject({ kind: "work", evidence: "tool call" });
  });

  test("does not credit a tool call nothing answers", () => {
    const gaps = findGaps([
      make("a", "2026-01-01T00:00:00.000Z", { toolCalls: ["call_1"] }),
      make("b", "2026-01-01T00:20:00.000Z", { role: "user" }),
    ]);

    expect(gaps[0]).toMatchObject({ kind: "idle", evidence: null });
  });

  test("reports unexplained gaps below the idle threshold as unknown", () => {
    const gaps = findGaps([
      make("a", "2026-01-01T00:00:00.000Z", { role: "user" }),
      make("b", "2026-01-01T00:07:00.000Z", { role: "user" }),
    ]);

    expect(gaps[0]).toMatchObject({ kind: "unknown", minutes: 7 });
  });

  test("classifies gaps under the report threshold too", () => {
    // The listing filters by --report; active time needs every gap.
    const gaps = findGaps([
      make("a", "2026-01-01T00:00:00.000Z", { role: "user" }),
      make("b", "2026-01-01T00:03:00.000Z", { role: "user" }),
    ]);

    expect(gaps[0]).toMatchObject({ kind: "unknown", minutes: 3 });
  });
});

// ---------- activeMinutes / buildReport ----------

describe("activeMinutes", () => {
  test("subtracts idle gaps only", () => {
    const rows = parseSessionFile(
      "f.jsonl",
      sessionFile([
        row("a1", "2026-01-01T00:00:00.000Z", { role: "user" }),
        row("a2", "2026-01-01T00:10:00.000Z", { role: "user" }),
        row("a3", "2026-01-01T01:00:00.000Z", { role: "user" }),
      ]),
    ).rows;
    const gaps = findGaps(rows, 15);

    // 60-minute span; the 50-minute gap is idle, the 10-minute one unknown.
    expect(gaps.map((gap) => gap.kind)).toEqual(["unknown", "idle"]);
    expect(activeMinutes(rows, gaps)).toBe(10);
  });
});

function firstLineage(files: string[]): NonNullable<ReturnType<typeof groupLineages>[number]> {
  const lineage = groupLineages(files.map((content, index) => parseSessionFile(`${index}.jsonl`, content)))[0];
  if (!lineage) throw new Error("fixture produced no lineage");
  return lineage;
}

describe("buildReport", () => {
  test("builds the span and active minutes from the rows", () => {
    // Dense rows (12-minute gaps) so nothing registers as idle: active ≈ span.
    const lineage = firstLineage([
      sessionFile([
        row("a1", "2026-01-01T00:00:00.000Z", { role: "user" }),
        row("a2", "2026-01-01T00:12:00.000Z", { role: "user" }),
        row("a3", "2026-01-01T00:24:00.000Z", { role: "user" }),
        row("a4", "2026-01-01T00:36:00.000Z", { role: "user" }),
        row("a5", "2026-01-01T00:48:00.000Z", { role: "user" }),
        row("a6", "2026-01-01T01:00:00.000Z", { role: "user" }),
      ]),
    ]);

    const report = buildReport(lineage, { idleMinutes: 15 });

    expect(report.spanMinutes).toBeCloseTo(60, 1);
    expect(report.activeMinutes).toBeCloseTo(60, 1);
    expect(report.idleMinutes).toBeCloseTo(0, 1);
    expect(report.rows).toBe(6);
    expect(report.files).toEqual(["0.jsonl"]);
    expect(report.assistantTurns).toBe(0);
    expect(report.userTurns).toBe(6);
    expect(report.lastRowAgoMinutes).toBeNull();
  });

  test("ages the last row against the run's clock and counts turns", () => {
    const lineage = firstLineage([
      sessionFile([
        row("u1", "2026-01-01T09:00:00.000Z", { role: "user" }),
        row("a1", "2026-01-01T09:05:00.000Z", { durationMs: 1000 }),
        row("u2", "2026-01-01T09:10:00.000Z", { role: "user" }),
      ]),
    ]);

    const report = buildReport(lineage, { idleMinutes: 15, now: Date.parse("2026-01-01T09:25:00.000Z") });

    expect(report.assistantTurns).toBe(1);
    expect(report.userTurns).toBe(2);
    expect(report.lastRowAgoMinutes).toBeCloseTo(15, 1);
  });
});

// ---------- format ----------

describe("format helpers", () => {
  test("shiftDay is calendar-safe across month and leap-year edges", () => {
    expect(shiftDay("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
  });

  test("localDay respects the time zone", () => {
    const epoch = Date.parse("2026-01-01T23:30:00.000Z");
    expect(localDay(epoch, "UTC")).toBe("2026-01-01");
    expect(localDay(epoch, "Europe/Prague")).toBe("2026-01-02");
  });

  test("clock renders in the zone it is given", () => {
    expect(clock(Date.parse("2026-01-01T00:05:09.000Z"), "UTC")).toBe("00:05:09");
    expect(clock(Date.parse("2026-01-01T00:05:09.000Z"), "Europe/Prague")).toBe("01:05:09");
  });

  test("formatHm rounds to whole minutes", () => {
    expect(formatHm(97)).toBe("1:37");
    expect(formatHm(60)).toBe("1:00");
    expect(formatHm(9)).toBe("0:09");
  });

  test("zonedEpoch reads a clock in the given zone", () => {
    expect(zonedEpoch("2026-01-01", "09:30", "UTC")).toBe(Date.parse("2026-01-01T09:30:00.000Z"));
    expect(zonedEpoch("2026-01-01", "09:30", "Europe/Prague")).toBe(Date.parse("2026-01-01T08:30:00.000Z"));
    expect(zonedEpoch("2026-07-01", "09:30", "Europe/Prague")).toBe(Date.parse("2026-07-01T07:30:00.000Z"));
  });

  test("zonedEpoch settles DST edges: overlaps early, gaps forward", () => {
    // Prague falls back on 2026-10-25 (02:30 twice) and jumps on 2026-03-29 (02:30 missing).
    expect(zonedEpoch("2026-10-25", "02:30", "Europe/Prague")).toBe(Date.parse("2026-10-25T00:30:00.000Z"));
    expect(clock(zonedEpoch("2026-03-29", "02:30", "Europe/Prague"), "Europe/Prague")).toBe("03:30:00");
    // New York falls back on 2026-11-01 and jumps on 2026-03-08.
    expect(zonedEpoch("2026-11-01", "01:30", "America/New_York")).toBe(Date.parse("2026-11-01T05:30:00.000Z"));
    expect(clock(zonedEpoch("2026-03-08", "02:30", "America/New_York"), "America/New_York")).toBe("03:30:00");
  });

  test("renders a text block and a JSON report", () => {
    const lineage = firstLineage([
      sessionFile([
        row("a1", "2026-01-01T00:00:00.000Z", { role: "user" }),
        row("a2", "2026-01-01T00:10:00.000Z", { role: "user" }),
        row("a3", "2026-01-01T00:20:00.000Z", { role: "user" }),
        row("a4", "2026-01-01T01:00:00.000Z", { role: "user" }),
      ]),
    ]);
    const report = buildReport(lineage, { idleMinutes: 15 });

    const text = renderText([report], { timeZone: "UTC" });
    expect(text).toContain("span 60.0 min (1:00), active 20.0 min (0:20), idle 40.0 min");
    expect(text).toContain("messages 0 assistant, 4 user");
    expect(text).toContain("gap 40.0 min idle (user → user)");
    expect(text).toContain("file 0.jsonl");
    expect(text).not.toContain("last row");

    const json = renderJson([report], { timeZone: "UTC" }).reports[0];
    expect(json).toMatchObject({
      activeMinutes: 20,
      spanMinutes: 60,
      idleMinutes: 40,
      rows: 4,
      userTurns: 4,
      lastRowAgoMinutes: null,
    });
    expect(json?.first).toBe("2026-01-01T00:00:00.000Z");
  });

  test("summarizes several sessions and shows the last-row age", () => {
    const first = firstLineage([
      sessionFile([
        row("b1", "2026-01-01T09:00:00.000Z", { role: "user" }),
        row("b2", "2026-01-01T09:10:00.000Z", { durationMs: 600_000 }),
      ]),
    ]);
    const second = firstLineage([
      sessionFile([
        row("c1", "2026-01-01T11:00:00.000Z", { role: "user" }),
        row("c2", "2026-01-01T11:10:00.000Z", { role: "user" }),
      ]),
    ]);
    const reports = [
      buildReport(first, { idleMinutes: 15, now: Date.parse("2026-01-01T09:15:00.000Z") }),
      buildReport(second, { idleMinutes: 15 }),
    ];

    const text = renderText(reports, { timeZone: "UTC" });
    expect(text).toContain("last row 5.0 min ago");
    expect(text).toContain("2 sessions: span 20.0 min (0:20), active 20.0 min (0:20)");

    const json = renderJson(reports, { timeZone: "UTC" });
    expect(json.totals).toEqual({ sessions: 2, spanMinutes: 20, activeMinutes: 20, idleMinutes: 0 });
  });

  test("the report threshold filters the listing without touching active time", () => {
    // An idle gap below --report must still be subtracted from active.
    const lineage = firstLineage([
      sessionFile([
        row("a1", "2026-01-01T00:00:00.000Z", { role: "user" }),
        row("a2", "2026-01-01T00:03:00.000Z", { role: "user" }),
      ]),
    ]);
    const report = buildReport(lineage, { idleMinutes: 2 });

    const wide = renderText([report], { timeZone: "UTC", reportMinutes: 5 });
    expect(wide).toContain("span 3.0 min (0:03), active 0.0 min (0:00), idle 3.0 min");
    expect(wide).toContain("gaps: none ≥5 min");

    const narrow = renderText([report], { timeZone: "UTC", reportMinutes: 2 });
    expect(narrow).toContain("gap 3.0 min idle (user → user)");
    expect(renderJson([report], { timeZone: "UTC", reportMinutes: 5 }).reports[0]?.gaps).toEqual([]);
    expect(renderJson([report], { timeZone: "UTC", reportMinutes: 2 }).reports[0]?.gaps[0]).toMatchObject({
      from: "user",
      to: "user",
    });
  });
});

// ---------- parseCli ----------

describe("parseCli", () => {
  test("defaults to today, 15 idle, 5 report", () => {
    expect(parseCli([])).toMatchObject({ date: undefined, idle: 15, report: 5, json: false, files: [] });
  });

  test("collects repeated --file flags", () => {
    expect(parseCli(["--file", "a.jsonl", "--file", "b.jsonl"]).files).toEqual(["a.jsonl", "b.jsonl"]);
  });

  test("accepts both --since/--until forms and rejects other text", () => {
    expect(parseCli(["--since", "18:30"])).toMatchObject({ since: "18:30" });
    expect(parseCli(["--until", "18:30:15"])).toMatchObject({ until: "18:30:15" });
    expect(parseCli(["--since", "2026-01-01T18:30"])).toMatchObject({ since: "2026-01-01T18:30" });

    expect(() => parseCli(["--since", "18"])).toThrow(/--since/);
    expect(() => parseCli(["--until", "tomorrow"])).toThrow(/--until/);
    expect(() => parseCli(["--since", "25:00"])).toThrow(/--since/);
    expect(() => parseCli(["--until", "18:99"])).toThrow(/--until/);
    expect(() => parseCli(["--since", "2026-13-01T09:00"])).toThrow(/--since/);
    expect(() => parseCli(["--date", "2026-13-01"])).toThrow(/--date/);
    expect(() => parseCli(["--date", "2026-02-30"])).toThrow(/--date/);
    expect(() => parseCli(["--since", "2026-02-30T09:00"])).toThrow(/--since/);
  });

  test("rejects bad values", () => {
    expect(() => parseCli(["--date", "01-01-2026"])).toThrow(/--date/);
    expect(() => parseCli(["--idle", "soon"])).toThrow(/--idle/);
  });

  test("rejects a stray positional", () => {
    expect(() => parseCli(["bogus"])).toThrow(/unexpected argument "bogus"/);
  });
});

// ---------- discovery / analyze / run ----------

describe("discoverFiles", () => {
  const files = {
    "root/--home-example-app--/2026-01-01T09-00-00-000Z_a.jsonl": "x",
    "root/--home-example-app--/2025-12-31T23-00-00-000Z_b.jsonl": "x",
    "root/--home-example-app--/2026-01-02T09-00-00-000Z_c.jsonl": "x",
    "root/--home-example-other--/2026-01-01T09-00-00-000Z_d.jsonl": "x",
  };
  const deps = memoryDeps(files);

  test("keeps the target day plus the neighbouring UTC days, per matching dir", () => {
    const found = discoverFiles(deps, parseCli(["--project", "app"]), "2026-01-01");

    expect(found).toEqual([
      "root/--home-example-app--/2025-12-31T23-00-00-000Z_b.jsonl",
      "root/--home-example-app--/2026-01-01T09-00-00-000Z_a.jsonl",
      "root/--home-example-app--/2026-01-02T09-00-00-000Z_c.jsonl",
    ]);
  });

  test("project matching is case-insensitive and skips other dirs", () => {
    const found = discoverFiles(deps, parseCli(["--project", "OTHER"]), "2026-01-01");

    expect(found).toEqual(["root/--home-example-other--/2026-01-01T09-00-00-000Z_d.jsonl"]);
  });

  test("explicit files bypass discovery", () => {
    expect(discoverFiles(deps, parseCli(["--file", "custom/path.jsonl"]), "2026-01-01")).toEqual(["custom/path.jsonl"]);
  });
});

describe("run", () => {
  const day = "2026-01-01";
  const morning = sessionFile(
    [
      row("a1", "2026-01-01T09:00:00.000Z", { role: "user" }),
      row("a2", "2026-01-01T09:10:00.000Z", { role: "user" }),
      row("a3", "2026-01-01T09:20:00.000Z", { role: "user" }),
      row("a4", "2026-01-01T09:30:00.000Z", { role: "user" }),
      row("a5", "2026-01-01T09:40:00.000Z", { role: "user" }),
    ],
    { cwd: "/home/example/app" },
  );

  test("reports a session's span and active time", () => {
    const deps = memoryDeps({ "root/--home-example-app--/2026-01-01T08-59-00-000Z_a.jsonl": morning });

    const result = run([], deps);

    expect(result.code).toBe(0);
    expect(result.text).toContain("span 40.0 min (0:40), active 40.0 min (0:40), idle 0.0 min");
  });

  test("finds a session opened after the UTC day rollover west of UTC", () => {
    // 19:30 America/New_York on the 1st is 00:30Z on the 2nd: the filename is
    // stamped day+1 relative to the local day being reported.
    const evening = sessionFile([
      row("a1", "2026-01-02T00:30:00.000Z", { role: "user" }),
      row("a2", "2026-01-02T00:40:00.000Z", { role: "user" }),
    ]);
    const deps = {
      ...memoryDeps({ "root/--home-example-app--/2026-01-02T00-30-00-000Z_a.jsonl": evening }),
      timeZone: "America/New_York",
    };

    const result = run(["--date", "2026-01-01"], deps);

    expect(result.code).toBe(0);
    expect(result.text).toContain("session 2026-01-01 19:30:00");
  });

  test("includes a lineage that started the day before", () => {
    const spanning = sessionFile(
      [
        row("a1", "2025-12-31T23:00:00.000Z", { role: "user" }),
        row("a2", "2026-01-01T00:10:00.000Z", { role: "user" }),
      ],
      { cwd: "/home/example/app" },
    );
    const deps = memoryDeps({ "root/--home-example-app--/2025-12-31T22-59-00-000Z_a.jsonl": spanning });

    const result = run(["--json"], deps);

    expect(result.code).toBe(0);
    expect(result.jsonMode).toBe(true);
    const reports = (result.json as { reports: Array<{ spanMinutes: number; files: string[] }> }).reports;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.spanMinutes).toBe(70);
    expect(reports[0]?.files).toHaveLength(1);
  });

  test("merges a rotated file and counts both", () => {
    const first = sessionFile([
      row("a1", "2026-01-01T09:00:00.000Z", { role: "user" }),
      row("a2", "2026-01-01T09:20:00.000Z", { role: "user" }),
    ]);
    const second = sessionFile([
      row("a2", "2026-01-01T09:20:00.000Z", { role: "user" }),
      row("b1", "2026-01-01T09:50:00.000Z", { role: "user" }),
    ]);
    const deps = memoryDeps({
      "root/--home-example-app--/2026-01-01T08-59-00-000Z_a.jsonl": first,
      "root/--home-example-app--/2026-01-01T09-20-00-000Z_b.jsonl": second,
    });

    const result = run([], deps);

    expect(result.code).toBe(0);
    expect(result.text).toContain("50.0 min"); // 09:00 → 09:50 across the rotation
    expect(result.text).toContain("3 rows, 2 files");
  });

  test("reports explicit files regardless of the day filter", () => {
    const past = sessionFile([
      row("p1", "2026-01-05T09:00:00.000Z", { role: "user" }),
      row("p2", "2026-01-05T09:30:00.000Z", { role: "user" }),
    ]);
    const deps = memoryDeps({ "custom/past.jsonl": past });

    const result = run(["--file", "custom/past.jsonl"], deps);

    expect(result.code).toBe(0);
    expect(result.text).toContain("span 30.0 min");
  });

  test("still filters explicit files by an explicit --date", () => {
    const past = sessionFile([row("p1", "2026-01-05T09:00:00.000Z", { role: "user" })]);
    const deps = memoryDeps({ "custom/past.jsonl": past });

    const result = run(["--file", "custom/past.jsonl", "--date", "2026-01-06"], deps);

    expect(result.code).toBe(1);
    expect(result.text).toBe("no sessions on 2026-01-06");
  });

  test("treats --date today as an explicit day for files too", () => {
    const past = sessionFile([row("p1", "2026-01-05T09:00:00.000Z", { role: "user" })]);
    const deps = memoryDeps({ "custom/past.jsonl": past });

    const result = run(["--file", "custom/past.jsonl", "--date", "today"], deps);

    expect(result.code).toBe(1);
    expect(result.text).toBe("no sessions on 2026-01-01");
  });

  test("keeps only the rows inside a --since/--until window", () => {
    const session = sessionFile([
      row("w1", "2026-01-01T09:00:00.000Z", { role: "user" }),
      row("w2", "2026-01-01T09:20:00.000Z", { role: "user" }),
      row("w3", "2026-01-01T09:40:00.000Z", { role: "user" }),
      row("w4", "2026-01-01T10:00:00.000Z", { role: "user" }),
    ]);
    const deps = memoryDeps({ "custom/window.jsonl": session });

    const result = run(
      ["--file", "custom/window.jsonl", "--since", "2026-01-01T09:15", "--until", "2026-01-01T09:45"],
      deps,
    );

    expect(result.code).toBe(0);
    // The 20-minute window holds two rows; the gap between them is idle.
    expect(result.text).toContain("span 20.0 min (0:20), active 0.0 min (0:00), idle 20.0 min");
  });

  test("reads a clock-form window in the report's zone", () => {
    // Rows are irregular so a UTC mis-reading keeps a different set.
    const session = sessionFile([
      row("p1", "2026-01-01T08:00:00.000Z", { role: "user" }),
      row("p2", "2026-01-01T08:10:00.000Z", { role: "user" }),
      row("p3", "2026-01-01T08:20:00.000Z", { role: "user" }),
      row("p4", "2026-01-01T08:40:00.000Z", { role: "user" }),
    ]);
    const deps = { ...memoryDeps({ "custom/window.jsonl": session }), timeZone: "Europe/Prague" };

    // 09:00–09:30 Prague in January is 08:00Z–08:30Z: three rows in, the 08:40Z one out;
    // read as UTC the window would keep nothing at all.
    const result = run(["--file", "custom/window.jsonl", "--since", "09:00", "--until", "09:30"], deps);

    expect(result.code).toBe(0);
    expect(result.text).toContain("span 20.0 min (0:20), active 20.0 min (0:20), idle 0.0 min");
    expect(result.text).toContain("session 2026-01-01 09:00:00 → 09:20:00 local");
  });

  test("keeps rows sitting exactly on a window bound, and supports one bound", () => {
    const session = sessionFile([
      row("q1", "2026-01-01T09:00:00.000Z", { role: "user" }),
      row("q2", "2026-01-01T09:10:00.000Z", { role: "user" }),
      row("q3", "2026-01-01T09:20:00.000Z", { role: "user" }),
    ]);
    const deps = memoryDeps({ "custom/edge.jsonl": session });

    const both = run(
      ["--file", "custom/edge.jsonl", "--since", "2026-01-01T09:00", "--until", "2026-01-01T09:10"],
      deps,
    );
    expect(both.code).toBe(0);
    expect(both.text).toContain("span 10.0 min (0:10)");
    expect(both.text).toContain("2 rows");

    const fromOnly = run(["--file", "custom/edge.jsonl", "--since", "2026-01-01T09:15"], deps);
    expect(fromOnly.text).toContain("span 0.0 min (0:00)");

    const untilOnly = run(["--file", "custom/edge.jsonl", "--until", "2026-01-01T09:05"], deps);
    expect(untilOnly.text).toContain("span 0.0 min (0:00)");
  });

  test("says the window is why nothing was reported", () => {
    const session = sessionFile([
      row("r1", "2026-01-01T08:00:00.000Z", { role: "user" }),
      row("r2", "2026-01-01T08:30:00.000Z", { role: "user" }),
    ]);
    const deps = memoryDeps({ "custom/early.jsonl": session });

    const result = run(["--file", "custom/early.jsonl", "--since", "09:00"], deps);

    expect(result.code).toBe(1);
    expect(result.text).toBe("no rows inside the --since/--until window");
    const json = result.json as { reports: unknown[]; totals: { sessions: number } };
    expect(json.reports).toEqual([]);
    expect(json.totals.sessions).toBe(0);
  });

  test("does not blame the window when the day matched nothing", () => {
    const result = run(["--project", "nonexistent", "--since", "09:00"], memoryDeps({}));

    expect(result.code).toBe(1);
    expect(result.text).toBe("no sessions on 2026-01-01");
  });

  test("rejects a window that ends before it starts", () => {
    const deps = memoryDeps({
      "custom/window.jsonl": sessionFile([row("p1", "2026-01-01T09:00:00.000Z", { role: "user" })]),
    });

    const result = run(["--file", "custom/window.jsonl", "--since", "10:00", "--until", "09:00"], deps);

    expect(result.code).toBe(1);
    expect(result.text).toContain("--until is before --since");
  });

  test("names the files, not a day, when explicit files hold no rows", () => {
    const deps = memoryDeps({ "custom/empty.jsonl": sessionFile([]) });

    const result = run(["--file", "custom/empty.jsonl"], deps);

    expect(result.code).toBe(1);
    expect(result.text).toBe("no sessions in the given files");
  });

  test("returns no sessions when the day has none", () => {
    const deps = memoryDeps({
      "root/--home-example-app--/2025-12-31T09-00-00-000Z_a.jsonl": sessionFile([
        row("a1", "2025-12-31T09:00:00.000Z"),
      ]),
    });

    const result = run([], deps);

    expect(result.code).toBe(1);
    expect(result.text).toBe(`no sessions on ${day}`);
  });

  test("honors --json even when the flags are wrong", () => {
    const result = run(["--json", "--nope"], memoryDeps({}));

    expect(result).toMatchObject({ code: 1, jsonMode: true });
    expect(result.json).toMatchObject({ error: expect.stringContaining("Unknown option") });
  });

  test("surfaces a format error", () => {
    const deps = memoryDeps({
      "root/--home-example-app--/2026-01-01T09-00-00-000Z_a.jsonl": sessionFile(
        [row("a1", "2026-01-01T09:00:00.000Z")],
        { version: 4 },
      ),
    });

    const result = run([], deps);

    expect(result.code).toBe(1);
    expect(result.text).toContain("session version 4");
  });

  test("prints help without touching sessions", () => {
    const result = run(["--help"], memoryDeps({}));

    expect(result.code).toBe(0);
    expect(result.text).toContain("usage: session-span");
  });
});
