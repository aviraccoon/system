import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMachine, parseDestinations, parseDevices, parseEnvFile, paths } from "./config";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "raccache-config-"));
  dirs.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("parseDestinations", () => {
  test("substitutes the host and defaults to mirror", () => {
    const { destinations, errors } = parseDestinations(
      `[[destination]]\nname = "b2"\nremote = "b2crypt:{host}"\n\n[[destination]]\nname = "cold"\nremote = "sftp:nas:/backups/{host}"\nmode = "copy"\nflags = ["--size-only"]\n`,
      "laptop",
    );
    expect(errors).toEqual([]);
    expect(destinations).toEqual([
      { name: "b2", remote: "b2crypt:laptop", mode: "mirror", flags: [] },
      { name: "cold", remote: "sftp:nas:/backups/laptop", mode: "copy", flags: ["--size-only"] },
    ]);
  });

  test("rejects a remote without a colon, a bad mode, and unknown fields", () => {
    expect(parseDestinations(`[[destination]]\nname = "x"\nremote = "nocolon"\n`, "h").errors[0]).toContain(
      "remote:path",
    );
    expect(parseDestinations(`[[destination]]\nname = "x"\nremote = "a:b"\nmode = "merge"\n`, "h").errors[0]).toContain(
      "'mode' must be",
    );
    expect(parseDestinations(`[[destination]]\nname = "x"\nremote = "a:b"\nspeed = 2\n`, "h").errors[0]).toContain(
      "unknown field 'speed'",
    );
  });

  test("rejects duplicate names", () => {
    const text = `[[destination]]\nname = "a"\nremote = "x:1"\n\n[[destination]]\nname = "a"\nremote = "y:2"\n`;
    expect(parseDestinations(text, "h").errors[0]).toContain("duplicate name");
  });

  test("rejects a comma in a name, which the start line uses as its separator", () => {
    expect(parseDestinations(`[[destination]]\nname = "b2,lon"\nremote = "x:1"\n`, "h").errors[0]).toContain("comma");
  });

  test("rejects whitespace, which the pass line uses as a field boundary", () => {
    expect(parseDestinations(`[[destination]]\nname = "b 2"\nremote = "x:1"\n`, "h").errors[0]).toContain("whitespace");
  });
});

describe("parseDevices", () => {
  test("parses a local device and a systemd device", () => {
    const { devices, errors } = parseDevices(
      `[[device]]\nname = "laptop"\nlocal = true\n\n[[device]]\nname = "server"\nssh = "server.example"\nunits = [{ unit = "backup-a", log = "a" }, { unit = "backup-b", log = "b" }]\n`,
    );
    expect(errors).toEqual([]);
    expect(devices).toEqual([
      { name: "laptop", local: true, ssh: undefined, units: [] },
      {
        name: "server",
        local: false,
        ssh: "server.example",
        units: [
          { unit: "backup-a", log: "a" },
          { unit: "backup-b", log: "b" },
        ],
      },
    ]);
  });

  test("requires exactly one of local and ssh", () => {
    expect(parseDevices(`[[device]]\nname = "x"\nlocal = true\nssh = "h"\n`).errors[0]).toContain("either");
    expect(parseDevices(`[[device]]\nname = "x"\n`).errors[0]).toContain("either");
  });

  test("rejects malformed units and duplicates", () => {
    expect(parseDevices(`[[device]]\nname = "x"\nssh = "h"\nunits = [{ unit = "a" }]\n`).errors[0]).toContain("unit");
    const text = `[[device]]\nname = "x"\nlocal = true\n\n[[device]]\nname = "x"\nssh = "h"\n`;
    expect(parseDevices(text).errors[0]).toContain("duplicate name");
  });
});

describe("parseEnvFile", () => {
  test("reads KEY=value lines, comments, and quotes", () => {
    const env = parseEnvFile(`# comment\nRCLONE_CONFIG_B2_KEY=abc\nEMPTY=\nQUOTED="with space"\nbad line\n`);
    expect(env).toEqual({ RCLONE_CONFIG_B2_KEY: "abc", EMPTY: "", QUOTED: "with space" });
  });
});

describe("loadMachine", () => {
  test("a missing destinations.toml fails loudly, a missing devices.toml falls back to this machine", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "targets.toml"), `[[target]]\ndest = "dev"\nsrc = "~/dev"\n`);
    const machine = loadMachine(paths({ dir, home: "/home/example" }), "/home/example");
    expect(machine.errors).toEqual([`no destination manifest at ${join(dir, "destinations.toml")}`]);
    expect(machine.devices).toHaveLength(1);
    expect(machine.devices[0]?.local).toBe(true);
    expect(machine.targets[0]?.src).toBe("/home/example/dev");
  });

  test("a comma in a target dest is refused", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "targets.toml"), `[[target]]\ndest = "dev,tmp"\nsrc = "~/dev"\n`);
    const machine = loadMachine(paths({ dir, home: "/home/example" }), "/home/example");
    expect(machine.errors.join(" ")).toContain("comma");
    expect(machine.targets).toHaveLength(0);
  });

  test("whitespace in a target dest is refused", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "targets.toml"), `[[target]]\ndest = "my dev"\nsrc = "~/dev"\n`);
    const machine = loadMachine(paths({ dir, home: "/home/example" }), "/home/example");
    expect(machine.errors.join(" ")).toContain("whitespace");
    expect(machine.targets).toHaveLength(0);
  });
});
