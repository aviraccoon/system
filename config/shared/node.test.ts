import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The module runs on `node:util` only, so Node has to execute it too. The suite itself
 * needs `bun:test`, so this spawns a Node fixture that exercises parse, help and the
 * exit-code mapping. Node strips types natively from 23.6; older versions take
 * `--experimental-strip-types`.
 */
const cliUrl = pathToFileURL(join(import.meta.dir, "cli.ts")).href;
const nodeBin = Bun.which("node");

/** Flags that let this Node import a `.ts` module, or null when it cannot. */
function nodeFlags(): string[] | null {
  if (!nodeBin) return null;
  const probe = `await import(${JSON.stringify(cliUrl)})`;
  for (const flags of [["--experimental-strip-types"], []]) {
    const result = Bun.spawnSync([nodeBin, ...flags, "-e", probe], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) return flags;
  }
  return null;
}

const flags = nodeFlags();

const FIXTURE = `
import { runCli, UsageError } from ${JSON.stringify(cliUrl)};

const spec = {
  name: "tool",
  summary: "a tool",
  flags: [
    { key: "json", type: "boolean", global: true, usage: "--json", help: "machine-readable output" },
    { key: "help", type: "boolean", global: true, short: "h", usage: "-h, --help", help: "this help" },
    { key: "note", type: "string", short: "n", synopsis: "[-n text]", usage: "-n, --note <text>", help: "a note" },
  ],
  commands: [
    {
      name: "go",
      args: "go <target>",
      summary: "go somewhere",
      flags: ["note"],
      handler: {
        min: 1,
        max: 1,
        run: (_ctx, args, cli) => {
          console.log(JSON.stringify({ args, note: cli.values.note, json: cli.values.json }));
          return 0;
        },
      },
    },
    {
      name: "boom",
      args: "boom",
      summary: "fail as a usage error",
      handler: {
        min: 0,
        max: 0,
        run: () => {
          throw new UsageError("boom: nope");
        },
      },
    },
  ],
};

process.exitCode = await runCli({ spec, argv: process.argv.slice(2) });
`;

let workDir = "";
let fixturePath = "";

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "cli-node-"));
  fixturePath = join(workDir, "fixture.ts");
  writeFileSync(fixturePath, FIXTURE);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function runNode(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([nodeBin as string, ...(flags ?? []), fixturePath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("node compatibility", () => {
  test.skipIf(flags === null)("parses a command and its flag", async () => {
    const result = await runNode("go", "target", "-n", "hi", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ args: ["target"], note: "hi", json: true });
  });

  test.skipIf(flags === null)("rejects a flag the command does not take", async () => {
    const result = await runNode("go", "target", "--bogus");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("tool go --help shows its flags");
  });

  test.skipIf(flags === null)("renders help and exits 0", async () => {
    const result = await runNode("--help");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("usage: tool [<command>] [args] [flags]");
    expect(result.stdout).toContain("run tool <command> --help for that command's usage and flags.");
  });

  test.skipIf(flags === null)("maps a handler UsageError to exit 2", async () => {
    const result = await runNode("boom");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("error: boom: nope");
    expect(result.stderr).toContain("(run tool --help for usage)");
  });

  test.skipIf(flags === null)("refuses an unknown command", async () => {
    const result = await runNode("frob");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command "frob"');
  });
});
