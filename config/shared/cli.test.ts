import { describe, expect, test } from "bun:test";
import {
  type CliSpec,
  type CommandSpec,
  commandNames,
  type ErrorReport,
  handledNames,
  handlerOf,
  helpText,
  type ParsedCli,
  parseCli,
  runCli,
  UsageError,
} from "./cli";

const FLAGS = [
  { key: "json", type: "boolean" as const, global: true, usage: "--json", help: "machine-readable output" },
  { key: "help", type: "boolean" as const, global: true, short: "h", usage: "-h, --help", help: "this help" },
  {
    key: "note",
    type: "string" as const,
    short: "n",
    synopsis: "[-n text]",
    usage: "-n, --note <text>",
    help: "a note",
  },
  {
    key: "path",
    type: "string" as const,
    multiple: true,
    synopsis: "[--path <p>]",
    usage: "--path <p>",
    help: "a path, repeatable",
  },
  {
    key: "force",
    type: "boolean" as const,
    short: "f",
    synopsis: "[--force]",
    usage: "-f, --force",
    help: "skip confirm",
  },
];

const noop = async (): Promise<number> => 0;

function app(overrides: Partial<CliSpec> = {}): CliSpec {
  const formHandler = { min: 0, max: 3, run: noop };
  const commands: CommandSpec[] = [
    { name: "status", args: "status", summary: "show state", handler: { min: 0, max: 0, run: noop } },
    {
      name: "start",
      args: "start <project>",
      summary: "start it",
      flags: ["note"],
      handler: { min: 1, max: 1, run: noop },
    },
    {
      name: "sim",
      args: "sim",
      summary: "simulator",
      commands: [
        {
          name: "start",
          args: "start <project>",
          summary: "start a session",
          flags: ["path"],
          handler: { min: 1, max: 1, run: noop },
        },
        { name: "end", args: "end", summary: "end a session", handler: { min: 0, max: 0, run: noop } },
      ],
    },
    { name: "alias", args: "alias [list|ls]", summary: "list aliases", handler: formHandler },
    { name: "alias", args: "alias <name> <project>", summary: "set an alias", flags: ["force"], handler: formHandler },
  ];
  const spec: CliSpec = { name: "tool", summary: "a test tool", flags: FLAGS, commands, ...overrides };
  // The default names the base command list; an override supplies its own list.
  if (overrides.commands === undefined && overrides.default === undefined) spec.default = "status";
  return spec;
}

describe("parseCli", () => {
  test("values, short flags, positionals", () => {
    const parsed = parseCli(app(), ["start", "acme", "-n", "hello", "--json"]);
    expect(parsed.commandPath).toEqual(["start"]);
    expect(parsed.positionals).toEqual(["start", "acme"]);
    expect(parsed.args).toEqual(["acme"]);
    expect(parsed.values.note).toBe("hello");
    expect(parsed.values.json).toBe(true);
  });

  test("repeatable option collects every value", () => {
    const parsed = parseCli(app(), ["sim", "start", "acme", "--path", "a", "--path", "b"]);
    expect(parsed.values.path).toEqual(["a", "b"]);
  });

  test("a flag the command does not take is rejected", () => {
    expect(() => parseCli(app(), ["status", "--note", "x"])).toThrow(UsageError);
    expect(() => parseCli(app(), ["status", "--note", "x"])).toThrow(/tool status --help/);
    expect(() => parseCli(app(), ["start", "acme", "--force"])).toThrow(/Unknown option/);
  });

  test("a global flag is accepted at any depth", () => {
    expect(parseCli(app(), ["sim", "start", "acme", "--json"]).values.json).toBe(true);
  });

  test("no command uses the default without consuming a positional", () => {
    const parsed = parseCli(app(), ["--json"]);
    expect(parsed.commandPath).toEqual(["status"]);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.args).toEqual([]);
  });

  test("unknown command is reported, not thrown", () => {
    const parsed = parseCli(app(), ["frob", "--json"]);
    expect(parsed.commandPath).toEqual([]);
    expect(parsed.unknown).toBe("frob");
    expect(parsed.positionals).toEqual(["frob"]);
  });

  test("unknown subcommand is reported against its parent path", () => {
    const parsed = parseCli(app(), ["sim", "frob"]);
    expect(parsed.commandPath).toEqual(["sim"]);
    expect(parsed.unknown).toBe("frob");
  });

  test("a group with no runnable fallback asks for a subcommand", () => {
    expect(parseCli(app(), ["sim"]).needsChild).toBe(true);
    expect(parseCli(app(), ["sim", "end"]).needsChild).toBeUndefined();
  });

  test("forms sharing a name share their flags", () => {
    expect(parseCli(app(), ["alias", "a", "b", "--force"]).values.force).toBe(true);
    expect(parseCli(app(), ["alias", "--force"]).values.force).toBe(true);
  });

  test("a default subcommand resolves without consuming a positional", () => {
    const spec = app({
      commands: [
        {
          name: "sim",
          args: "sim",
          summary: "simulator",
          default: "end",
          commands: [
            { name: "start", args: "start", summary: "start", handler: { min: 0, max: 0, run: noop } },
            { name: "end", args: "end", summary: "end", handler: { min: 0, max: 0, run: noop } },
          ],
        },
      ],
    });
    const parsed = parseCli(spec, ["sim"]);
    expect(parsed.commandPath).toEqual(["sim", "end"]);
    expect(parsed.args).toEqual([]);
  });

  test("no flags at all still parses positionals", () => {
    const spec: CliSpec = {
      name: "bare",
      summary: "bare",
      args: "<path>...",
      flags: [],
      handler: { min: 1, max: 9, run: noop },
    };
    const parsed = parseCli(spec, ["a", "b"]);
    expect(parsed.positionals).toEqual(["a", "b"]);
    expect(parsed.args).toEqual(["a", "b"]);
  });

  test("a single-command app accepts its own flags", () => {
    const spec: CliSpec = { name: "bare", summary: "bare", flags: FLAGS, handler: { min: 0, max: 9, run: noop } };
    const parsed = parseCli(spec, ["--note", "hi", "--path", "a", "--path", "b", "x"]);
    expect(parsed.values.note).toBe("hi");
    expect(parsed.values.path).toEqual(["a", "b"]);
    expect(parsed.args).toEqual(["x"]);
  });

  test("a single-command flag error names the app once", () => {
    const spec: CliSpec = { name: "bare", summary: "bare", flags: FLAGS, handler: { min: 0, max: 9, run: noop } };
    expect(() => parseCli(spec, ["--bogus"])).toThrow(/bare --help shows its flags/);
    expect(() => parseCli(spec, ["--bogus"])).not.toThrow(/bare bare/);
  });
});

describe("helpText", () => {
  test("no help flag means no text", () => {
    expect(helpText(app(), { help: false, positionals: ["status"] })).toBeNull();
    expect(helpText(app(), { help: false, positionals: [] })).toBeNull();
  });

  test("full help lists commands, global flags and the pointer", () => {
    const text = helpText(app(), { help: true, positionals: [] }) ?? "";
    expect(text).toContain("usage: tool [<command>] [args] [flags]");
    expect(text).toContain("  status ");
    expect(text).toContain("--json");
    expect(text).toContain("machine-readable output");
    expect(text).toContain("run tool <command> --help for that command's usage and flags.");
    expect(text).not.toContain("a note");
  });

  test("a command page lists only its own flags", () => {
    const text = helpText(app(), { help: true, positionals: ["start"] }) ?? "";
    expect(text).toContain("usage: tool start <project> [-n text]");
    expect(text).toContain("-n, --note <text>");
    expect(text).toContain("--json");
    expect(text).not.toContain("--force");
    expect(text).not.toContain("--path");
  });

  test("help <command> and <command> --help reach the same page", () => {
    expect(helpText(app(), { help: true, positionals: ["start"] })).toBe(
      helpText(app(), { help: false, positionals: ["help", "start"] }),
    );
  });

  test("a form-sharing command lists every usage", () => {
    const text = helpText(app(), { help: true, positionals: ["alias"] }) ?? "";
    expect(text).toContain("usage:\n  tool alias [list|ls]\n  tool alias <name> <project> [--force]");
  });

  test("a group page lists its subcommands", () => {
    const text = helpText(app(), { help: true, positionals: ["sim"] }) ?? "";
    expect(text).toContain("usage: tool sim");
    expect(text).toContain("commands:");
    expect(text).toContain("start <project>");
    expect(text).toContain("end");
    expect(text).toContain("run tool --help for all commands");
  });

  test("a group page ignores the group's default subcommand", () => {
    const spec = app({
      commands: [
        {
          name: "sim",
          args: "sim",
          summary: "simulator",
          default: "end",
          commands: [
            { name: "start", args: "start", summary: "start", handler: { min: 0, max: 0, run: noop } },
            { name: "end", args: "end", summary: "end", handler: { min: 0, max: 0, run: noop } },
          ],
        },
      ],
    });
    const text = helpText(spec, { help: true, positionals: ["sim"] }) ?? "";
    expect(text).toContain("usage: tool sim");
    expect(text).toContain("start");
    expect(text).toContain("end");
  });

  test("a wrapped flag description aligns under the description column", () => {
    const spec: CliSpec = {
      name: "bare",
      summary: "bare tool",
      flags: [{ key: "x", type: "string", usage: "--long <value>", help: "word ".repeat(30).trim() }],
      handler: { min: 0, max: 9, run: noop },
    };
    const lines = (helpText(spec, { help: true, positionals: [] }) ?? "").split("\n");
    const start = lines.findIndex((line) => line.includes("--long <value>"));
    expect(start).toBeGreaterThan(-1);
    const column = "  --long <value>    ".length;
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "") break;
      expect(line.startsWith(" ".repeat(column))).toBe(true);
      expect(line.startsWith(" ".repeat(column + 1))).toBe(false);
    }
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(100);
  });

  test("a page with no flags omits the flags heading", () => {
    const spec: CliSpec = {
      name: "bare",
      summary: "bare tool",
      flags: [],
      handler: { min: 0, max: 9, run: noop },
    };
    const text = helpText(spec, { help: true, positionals: [] }) ?? "";
    expect(text).toContain("usage: bare");
    expect(text).not.toContain("[flags]");
    expect(text).not.toContain("flags:");
    const withCommands: CliSpec = {
      name: "bare",
      summary: "bare tool",
      flags: [],
      default: "status",
      commands: [
        { name: "status", args: "status", summary: "show state", handler: { min: 0, max: 0, run: noop } },
        { name: "go", args: "go <target>", summary: "go somewhere", handler: { min: 1, max: 1, run: noop } },
      ],
    };
    const full = helpText(withCommands, { help: true, positionals: [] }) ?? "";
    const page = helpText(withCommands, { help: true, positionals: ["status"] }) ?? "";
    expect(full).toContain("usage: bare [<command>] [args]");
    expect(full).not.toContain("[flags]");
    expect(full).not.toContain("flags:");
    expect(page).not.toContain("flags:");
  });

  test("a nested page prints its full path", () => {
    const text = helpText(app(), { help: true, positionals: ["sim", "start"] }) ?? "";
    expect(text).toContain("usage: tool sim start <project> [--path <p>]");
  });

  test("an unknown help target falls back to the full page", () => {
    expect(helpText(app(), { help: false, positionals: ["help", "frob"] })).toBe(
      helpText(app(), { help: true, positionals: [] }),
    );
  });

  test("no rendered line exceeds the wrap column", () => {
    const text = helpText(app(), { help: true, positionals: [] }) ?? "";
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  test("a single-command app has no commands section", () => {
    const spec: CliSpec = {
      name: "bare",
      summary: "bare tool",
      args: "<path>...",
      intro: "prose about the tool",
      flags: FLAGS,
      handler: { min: 0, max: 9, run: noop },
    };
    const text = helpText(spec, { help: true, positionals: [] }) ?? "";
    expect(text).toContain("usage: bare <path>... [flags]");
    expect(text).not.toContain("commands:");
    expect(text).toContain("prose about the tool");
  });
});

describe("name helpers", () => {
  test("commandNames dedupes forms and handledNames reports handlers", () => {
    expect(commandNames(app())).toEqual(["status", "start", "sim", "alias"]);
    expect(handledNames(app())).toEqual(["status", "start", "alias"]);
  });

  test("inherited object properties are not commands", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(handlerOf(app(), name)).toBeUndefined();
    }
    expect(handlerOf(app(), "status")).toBeDefined();
  });
});

describe("load invariants", () => {
  test("a flag key that is not declared throws", () => {
    expect(() =>
      parseCli(
        app({
          commands: [{ name: "x", args: "x", flags: ["nope"], handler: { min: 0, max: 0, run: noop } }],
        }),
        ["x"],
      ),
    ).toThrow(/unknown flag "nope"/);
  });

  test("a leaf without a handler throws", () => {
    expect(() => parseCli(app({ commands: [{ name: "x", args: "x" }] }), ["x"])).toThrow(/no handler/);
  });

  test("two different handlers for one name throw", () => {
    const commands: CommandSpec[] = [
      { name: "x", args: "x", handler: { min: 0, max: 0, run: noop } },
      { name: "x", args: "x <a>", handler: { min: 0, max: 5, run: noop } },
    ];
    expect(() => parseCli(app({ commands }), ["x"])).toThrow(/more than one handler/);
  });

  test("a name cannot have both forms and subcommands", () => {
    const shared = { min: 0, max: 0, run: noop };
    const commands: CommandSpec[] = [
      {
        name: "x",
        args: "x",
        handler: shared,
        commands: [{ name: "y", args: "y", handler: { min: 0, max: 0, run: noop } }],
      },
      { name: "x", args: "x <a>", handler: shared },
    ];
    expect(() => parseCli(app({ commands }), ["x"])).toThrow(/forms and subcommands/);
  });

  test("an undeclared default names an error", () => {
    expect(() => parseCli(app({ default: "nope" }), [])).toThrow(/default command "nope"/);
  });

  test("a duplicate flag key throws", () => {
    const spec = app({ flags: [...FLAGS, { ...FLAGS[0], usage: "--json" }] });
    expect(() => parseCli(spec, [])).toThrow(/duplicate flag "json"/);
  });

  test("a short name that is not one character throws", () => {
    const spec = app({ flags: [{ key: "x", type: "boolean", short: "xx", usage: "-x", help: "x" }] });
    expect(() => parseCli(spec, [])).toThrow(/not one character/);
  });

  test("an undeclared subcommand default throws", () => {
    const commands: CommandSpec[] = [
      {
        name: "x",
        args: "x",
        default: "nope",
        commands: [{ name: "y", args: "y", handler: { min: 0, max: 0, run: noop } }],
      },
    ];
    expect(() => parseCli(app({ commands }), ["x"])).toThrow(/default subcommand "nope"/);
  });
});

describe("runCli", () => {
  function harness(spec: CliSpec = app(), overrides: Partial<Parameters<typeof runCli>[0]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const options = {
      spec,
      argv: [] as string[],
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
      ...overrides,
    };
    return { run: (argv: string[]) => runCli({ ...options, argv }), out, err };
  }

  test("help prints and exits 0 without running the handler", async () => {
    let ran = false;
    const spec = app({
      commands: [
        {
          name: "status",
          args: "status",
          summary: "show state",
          handler: {
            min: 0,
            max: 0,
            run: () => {
              ran = true;
              return 0;
            },
          },
        },
      ],
      default: "status",
    });
    const h = harness(spec);
    expect(await h.run(["--help"])).toBe(0);
    expect(ran).toBe(false);
    expect(h.out.join("\n")).toContain("usage: tool [<command>]");
  });

  test("the default command runs with no arguments", async () => {
    const calls: string[][] = [];
    const spec = app({
      commands: [
        {
          name: "status",
          args: "status",
          summary: "show state",
          handler: {
            min: 0,
            max: 0,
            run: (_ctx: unknown, args: string[]) => {
              calls.push(args);
              return 0;
            },
          },
        },
      ],
      default: "status",
    });
    expect(await harness(spec).run([])).toBe(0);
    expect(calls).toEqual([[]]);
  });

  test("unknown command exits 2 with the usage pointer", async () => {
    const h = harness();
    expect(await h.run(["frob"])).toBe(2);
    expect(h.err).toEqual(['error: unknown command "frob"', "(run tool --help for usage)"]);
  });

  test("unknown subcommand names its parent", async () => {
    const h = harness();
    expect(await h.run(["sim", "frob"])).toBe(2);
    expect(h.err[0]).toBe('error: unknown command "frob" for sim');
  });

  test("a group with no subcommand names the choices", async () => {
    const h = harness();
    expect(await h.run(["sim"])).toBe(2);
    expect(h.err[0]).toBe('error: missing subcommand for "tool sim": <start|end>');
  });

  test("arity is checked against the resolved command", async () => {
    const h = harness();
    expect(await h.run(["start"])).toBe(2);
    expect(h.err[0]).toBe("error: start: missing argument(s)");
  });

  test("a UsageError from the adapter exits 2", async () => {
    const h = harness(app(), {
      adapt: () => {
        throw new UsageError("bad value");
      },
    });
    expect(await h.run(["status"])).toBe(2);
    expect(h.err).toEqual(["error: bad value", "(run tool --help for usage)"]);
  });

  test("a single-command app dispatches through the spec handler", async () => {
    const calls: string[][] = [];
    const spec: CliSpec = {
      name: "bare",
      summary: "bare tool",
      flags: FLAGS,
      handler: {
        min: 0,
        max: 9,
        run: (_ctx: unknown, args: string[]) => {
          calls.push(args);
          return 0;
        },
      },
    };
    const h = harness(spec);
    expect(await h.run(["a", "b"])).toBe(0);
    expect(calls).toEqual([["a", "b"]]);
  });

  test("a UsageError from a handler exits 2", async () => {
    const spec = app({
      commands: [
        {
          name: "x",
          args: "x",
          summary: "x",
          handler: {
            min: 0,
            max: 0,
            run: () => {
              throw new UsageError("x: bad form");
            },
          },
        },
      ],
    });
    const h = harness(spec);
    expect(await h.run(["x"])).toBe(2);
    expect(h.err).toEqual(["error: x: bad form", "(run tool --help for usage)"]);
  });

  test("mapError owns an app-specific failure", async () => {
    class ApiError extends Error {}
    const spec = app({
      commands: [
        {
          name: "x",
          args: "x",
          summary: "x",
          handler: {
            min: 0,
            max: 0,
            run: () => {
              throw new ApiError("boom");
            },
          },
        },
      ],
    });
    const h = harness(spec, {
      mapError: (error): ErrorReport | undefined =>
        error instanceof ApiError ? { code: 1, lines: [`api error: ${error.message}`] } : undefined,
    });
    expect(await h.run(["x"])).toBe(1);
    expect(h.err).toEqual(["api error: boom"]);
  });

  test("an unexpected error exits 1", async () => {
    const spec = app({
      commands: [
        {
          name: "x",
          args: "x",
          summary: "x",
          handler: {
            min: 0,
            max: 0,
            run: () => {
              throw new Error("boom");
            },
          },
        },
      ],
    });
    const h = harness(spec);
    expect(await h.run(["x"])).toBe(1);
    expect(h.err).toEqual(["error: boom"]);
  });

  test("a numeric result is the exit code", async () => {
    const spec = app({
      commands: [{ name: "x", args: "x", summary: "x", handler: { min: 0, max: 0, run: () => 3 } }],
    });
    expect(await harness(spec).run(["x"])).toBe(3);
  });

  test("a result is printed with the adapted cli", async () => {
    const spec = app({
      commands: [
        { name: "x", args: "x", summary: "x", flags: ["note"], handler: { min: 0, max: 0, run: () => "done" } },
      ],
    });
    const h = harness(spec, {
      adapt: (parsed: ParsedCli) => ({ note: parsed.values.note as string | undefined }),
      print: (result, cli) => {
        const view = cli as { note?: string };
        h.out.push(`${String(result)}:${view.note ?? ""}`);
      },
    });
    expect(await h.run(["x", "--note", "hi"])).toBe(0);
    expect(h.out).toEqual(["done:hi"]);
  });

  test("the context is built from the adapted cli", async () => {
    const spec = app({
      commands: [
        {
          name: "x",
          args: "x",
          summary: "x",
          flags: ["note"],
          handler: {
            min: 0,
            max: 0,
            run: (ctx: { note: string }) => {
              if (ctx.note !== "hi") throw new Error("no context");
              return 0;
            },
          },
        },
      ],
    });
    const h = harness(spec, {
      adapt: (parsed: ParsedCli) => ({ note: parsed.values.note as string }),
      context: (cli) => ({ note: (cli as { note: string }).note }),
    });
    expect(await h.run(["x", "--note", "hi"])).toBe(0);
  });
});
