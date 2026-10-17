import { describe, expect, test } from "bun:test";
import {
  computeRates,
  fmtAgo,
  fmtBytes,
  fmtIn,
  fmtRate,
  parseCollector,
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
