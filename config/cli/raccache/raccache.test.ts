import { describe, expect, test } from "bun:test";
import type { Device } from "./config";
import { parseCli, selectDevices } from "./raccache";

const device = (name: string, local = false): Device => ({ name, local, units: [] });

describe("parseCli", () => {
  test("defaults to a status snapshot", () => {
    const cli = parseCli([]);
    expect(cli.command).toBe("status");
    expect(cli.interval).toBe(30);
    expect(cli.watch).toBe(false);
    expect(cli.devices).toEqual([]);
  });

  test("run carries the dry-run and scope flags", () => {
    const cli = parseCli(["run", "--dry-run", "--only", "dev", "--destination", "r2"]);
    expect(cli.command).toBe("run");
    expect(cli.dryRun).toBe(true);
    expect(cli.only).toBe("dev");
    expect(cli.destination).toBe("r2");
  });

  test("filters takes the target as a positional", () => {
    const cli = parseCli(["filters", "dev"]);
    expect(cli.command).toBe("filters");
    expect(cli.target).toBe("dev");
  });

  test("--device is repeatable", () => {
    const cli = parseCli(["pause", "--device", "a", "--device", "b"]);
    expect(cli.command).toBe("pause");
    expect(cli.devices).toEqual(["a", "b"]);
  });

  test("rejects a non-positive or non-numeric interval", () => {
    expect(() => parseCli(["--interval", "abc"])).toThrow();
    expect(() => parseCli(["--interval", "0"])).toThrow();
    expect(() => parseCli(["--interval", "-5"])).toThrow();
  });

  test("rejects unknown commands", () => {
    expect(() => parseCli(["frobnicate"])).toThrow();
  });
});

describe("selectDevices", () => {
  const devices = [device("laptop", true), device("server"), device("nas")];

  test("no names selects everything", () => {
    expect(selectDevices(devices, []).devices).toHaveLength(3);
  });

  test("names select a subset and report unknown ones", () => {
    const { devices: selected, unknown } = selectDevices(devices, ["server", "ghost"]);
    expect(selected.map((entry) => entry.name)).toEqual(["server"]);
    expect(unknown).toEqual(["ghost"]);
  });
});
