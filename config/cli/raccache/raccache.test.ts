import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("--path is repeatable and empty by default", () => {
    expect(parseCli(["run", "--path", "Downloads", "--path", "Pictures/x.png"]).path).toEqual([
      "Downloads",
      "Pictures/x.png",
    ]);
    expect(parseCli(["run"]).path).toEqual([]);
  });

  test("filters takes the target as a positional", () => {
    const cli = parseCli(["filters", "dev"]);
    expect(cli.command).toBe("filters");
    expect(cli.target).toBe("dev");
  });

  test("a flag the command does not take is rejected", () => {
    expect(() => parseCli(["run", "--watch"])).toThrow(/Unknown option/);
    expect(() => parseCli(["status", "--dry-run"])).toThrow(/Unknown option/);
    expect(() => parseCli(["pause", "--only", "dev"])).toThrow(/Unknown option/);
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

describe("CLI process", () => {
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "raccache-test-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  async function runRaccache(...args: string[]): Promise<{ stderr: string; code: number }> {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "raccache.ts"), ...args], {
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stderr, code };
  }

  test("an unknown command exits 2", async () => {
    const result = await runRaccache("frob");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command "frob"');
  });

  test("a flag on the wrong command exits 2", async () => {
    const result = await runRaccache("run", "--json");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("raccache run --help");
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
