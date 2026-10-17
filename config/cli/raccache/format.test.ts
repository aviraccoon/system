import { describe, expect, test } from "bun:test";
import {
  computeRates,
  fmtAgo,
  fmtBytes,
  fmtIn,
  fmtRate,
  parseCollector,
  parseRunProgress,
  parseTransferLine,
  renderSide,
  type SideState,
} from "./format";

describe("fmtBytes", () => {
  test("bytes", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  test("kib and mib", () => {
    expect(fmtBytes(1024)).toBe("1.0 KiB");
    expect(fmtBytes(1536)).toBe("1.5 KiB");
    expect(fmtBytes(10 * 1024)).toBe("10 KiB");
  });

  test("gib", () => {
    expect(fmtBytes(5.5 * 1024 ** 3)).toBe("5.5 GiB");
    expect(fmtBytes(150 * 1024 ** 3)).toBe("150 GiB");
  });

  test("missing value", () => {
    expect(fmtBytes(undefined)).toBe("—");
  });
});

describe("fmtRate, fmtAgo, fmtIn", () => {
  test("rate", () => {
    expect(fmtRate(1024 * 1024)).toBe("1.0 MiB/s");
  });

  test("ago", () => {
    const now = 10_000_000;
    expect(fmtAgo(now - 5_000, now)).toBe("5s");
    expect(fmtAgo(now - 120_000, now)).toBe("2m");
    expect(fmtAgo(now - 3 * 3_600_000, now)).toBe("3h00m");
  });

  test("in", () => {
    expect(fmtIn(1_000_300, 1_000_000_000)).toBe("5m");
    expect(fmtIn(1_003_600, 1_000_000_000)).toBe("1h00m");
    expect(fmtIn(999_000, 1_000_000_000)).toBe("now");
  });
});

describe("parseCollector", () => {
  const fixture = [
    "PAUSED 1",
    "UNIT backup-offsite activating",
    "UNIT backup-services inactive",
    "TIMER backup-offsite @1792217466",
    "TIMER backup-services -",
    "TIMER plain 1792217000",
    "LOG offsite 2026-01-01T00:00:00Z example/file.txt: Copied (new)",
    "PROGRESS offsite Transferred: 1.0 GiB / 2.0 GiB, 50%, 12.0 MiB/s, ETA 1m2s",
    "SAMPLED 1792217000",
    'SIZE photos/albums {"count":3,"bytes":4096}',
    "NOTE nothing configured",
  ].join("\n");

  test("parses every line kind", () => {
    const parsed = parseCollector(fixture);
    expect(parsed.paused).toBe(true);
    expect(parsed.units["backup-offsite"]).toBe("activating");
    expect(parsed.timers["backup-offsite"]).toBe(1792217466);
    expect(parsed.timers.plain).toBe(1792217000);
    expect(parsed.timers["backup-services"]).toBeUndefined();
    expect(parsed.sizes).toHaveLength(1);
    expect(parsed.sizes[0]?.path).toBe("photos/albums");
    expect(parsed.sizes[0]?.bytes).toBe(4096);
    expect(parsed.notes).toEqual(["nothing configured"]);
    expect(parsed.logs.offsite).toContain("Copied (new)");
    expect(parsed.progress.offsite).toContain("50%");
    expect(parsed.sampled).toBe(1792217000);
  });

  test("tolerates junk", () => {
    const parsed = parseCollector("garbage\n\nPAUSED 0\nSIZE broken {not json}");
    expect(parsed.paused).toBe(false);
    expect(parsed.sizes[0]?.bytes).toBe(0);
  });
});

describe("parseTransferLine", () => {
  test("strips the label", () => {
    expect(parseTransferLine("Transferred: 1.0 GiB / 2.0 GiB, 50%, ETA 1m")).toBe("1.0 GiB / 2.0 GiB, 50%, ETA 1m");
  });

  test("treats absent and placeholder values as nothing", () => {
    expect(parseTransferLine(undefined)).toBeUndefined();
    expect(parseTransferLine("-")).toBeUndefined();
  });
});

describe("computeRates", () => {
  test("computes bytes per second between size samples", () => {
    const prev: SideState = {
      label: "a",
      paused: false,
      targets: [{ path: "x", bytes: 1_000, objects: 1 }],
      info: [],
      at: 1_000_000,
      sampled: 1_000_000,
    };
    const cur: SideState = {
      label: "a",
      paused: false,
      targets: [{ path: "x", bytes: 11_000, objects: 2 }],
      info: [],
      at: 1_060_000,
      sampled: 1_010_000,
    };
    expect(computeRates(prev, cur).x).toBe(1000);
  });

  test("no rate without a fresh sample", () => {
    const prev: SideState = {
      label: "a",
      paused: false,
      targets: [{ path: "x", bytes: 1_000, objects: 1 }],
      info: [],
      at: 1_000_000,
      sampled: 1_000_000,
    };
    const cur: SideState = { ...prev, targets: [{ path: "x", bytes: 11_000, objects: 2 }], at: 1_030_000 };
    expect(computeRates(prev, cur)).toEqual({});
  });

  test("no previous sample means no rates", () => {
    const cur: SideState = { label: "a", paused: false, targets: [], info: [], at: 0 };
    expect(computeRates(undefined, cur)).toEqual({});
  });
});

describe("parseRunProgress", () => {
  const plan = ["b2/dev", "b2/Documents"];
  const start = "2026-10-17T05:00:00.000Z raccache start (2 pairs: b2/dev, b2/Documents)\n";

  test("names the pair being transferred and how long the run has gone", () => {
    const log = `${start}2026-10-17T05:00:10.000Z b2/dev ok (3 new, 0 changed, 0 deleted)\n`;
    expect(parseRunProgress(log, plan, Date.parse("2026-10-17T05:12:00.000Z"))).toBe(
      "2 of 2 (b2/Documents) · 12m elapsed",
    );
  });

  test("no running pass once the run has finished", () => {
    expect(parseRunProgress(`${start}2026-10-17T05:01:00.000Z raccache done rc=0 (0 new)\n`, plan)).toBeUndefined();
  });

  test("a skipped target is not left as the pair in progress", () => {
    const log = `${start}2026-10-17T05:00:10.000Z b2/Documents SKIPPED (missing): /Users/example/Documents\n`;
    const progress = parseRunProgress(log, plan, Date.parse("2026-10-17T05:02:00.000Z")) ?? "";
    expect(progress).toContain("2 of 2");
    expect(progress).not.toContain("Documents");
  });

  test("an aborted pair does not stay current", () => {
    const log = `${start}2026-10-17T05:00:10.000Z b2/dev ABORTED: on battery power\n`;
    expect(parseRunProgress(log, plan, Date.parse("2026-10-17T05:02:00.000Z"))).toContain("(b2/Documents)");
  });

  test("a narrowed pass is scored against its own start line", () => {
    const narrowed = "2026-10-17T05:00:00.000Z raccache start (1 pair: b2/Documents)\n";
    const log = `${narrowed}2026-10-17T05:00:10.000Z b2/Documents ok (1 new, 0 changed, 0 deleted)\n`;
    expect(parseRunProgress(log, plan, Date.parse("2026-10-17T05:02:00.000Z"))).toBe("1 of 1 (finishing) · 2m elapsed");
  });

  test("finishing once every pair is done but the run line is not written yet", () => {
    const log = `${start}2026-10-17T05:01:00.000Z b2/dev ok (1 new, 0 changed, 0 deleted)\n2026-10-17T05:01:30.000Z b2/Documents SKIPPED (missing)\n`;
    expect(parseRunProgress(log, plan, Date.parse("2026-10-17T05:02:00.000Z"))).toBe("2 of 2 (finishing) · 2m elapsed");
  });

  const siblings = ["b2/dev", "r2/dev"];
  const legacyStart = "2026-10-17T05:00:00.000Z raccache start (2 pairs: 2 targets x 1 destination)\n";

  test("a target-level line does not end a sibling destination's pair when the list is present", () => {
    const log = `${start}2026-10-17T05:00:10.000Z dev SKIPPED (missing)\n`;
    expect(parseRunProgress(log, siblings, Date.parse("2026-10-17T05:02:00.000Z"))).toBe(
      "1 of 2 (b2/dev) · 2m elapsed",
    );
  });

  test("one destination's line does not end its sibling on a start line without a list", () => {
    const log = `${legacyStart}2026-10-17T05:00:10.000Z b2/dev ok (3 new, 0 changed, 0 deleted)\n`;
    expect(parseRunProgress(log, siblings, Date.parse("2026-10-17T05:02:00.000Z"))).toBe(
      "2 of 2 (r2/dev) · 2m elapsed",
    );
  });

  test("a start line without a pair list falls back to the configured pairs", () => {
    const legacy = "2026-10-17T05:00:00.000Z raccache start (2 targets x 1 destination)\n";
    const log = `${legacy}2026-10-17T05:00:10.000Z Documents SKIPPED (missing)\n`;
    expect(parseRunProgress(log, plan, Date.parse("2026-10-17T05:02:00.000Z"))).toBe("2 of 2 (b2/dev) · 2m elapsed");
  });

  test("no run in the log at all", () => {
    expect(parseRunProgress("", plan)).toBeUndefined();
  });
});

describe("renderSide", () => {
  test("renders flags, targets, and rates", () => {
    const side: SideState = {
      label: "raccpat (server)",
      paused: true,
      targets: [{ path: "photos/albums", bytes: 1024, objects: 1 }],
      info: ["units  backup-offsite=activating"],
      lastLog: "2026-01-01T00:00:00Z file.txt: Copied (new)",
      at: 1_000_000,
    };
    const text = renderSide(side, { "photos/albums": 1024 }, new Date(1_010_000));
    expect(text).toContain("raccpat (server)");
    expect(text).toContain("PAUSED");
    expect(text).toContain("1.0 KiB");
    expect(text).toContain("1.0 KiB/s");
    expect(text).toContain("backup-offsite=activating");
    expect(text).toContain("Copied (new)");
  });
});
