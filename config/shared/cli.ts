/**
 * Shared command-line parsing, help and dispatch for the repo's bun CLIs and scripts.
 *
 * One app is described by a `CliSpec`: flags declared once in a table, commands as a
 * recursive tree (a group's children nest), and each leaf carrying its handler. Parsing,
 * help rendering and dispatch all read that one table, so they cannot drift.
 *
 * Importing this module has no side effects: no `process.argv` read, no `process.exit`,
 * no auto-run. Keep it that way. A module that is also loaded as a library can then pull
 * this in with `await import()` in its CLI branch, without paying for it on every load.
 *
 * `node:util` parseArgs edges: `type` is boolean|string only, boolean options reject
 * `--flag=false`, a negative value needs `--n=-5`, and a repeated non-`multiple` flag
 * keeps the last value.
 */

import { type ParseArgsOptionsConfig, parseArgs } from "node:util";

/** One option. `key` is the parseArgs name and the `values` key. */
export interface FlagSpec {
  key: string;
  type: "string" | "boolean";
  /** Collect repeated occurrences into an array instead of keeping the last. */
  multiple?: boolean;
  short?: string;
  /** Accepted at every level and rendered in the app's own help. */
  global?: boolean;
  /** Token as it appears in a command synopsis; empty when the usage line lists it. */
  synopsis?: string;
  /** Left column of the flag list, e.g. `-n, --note <text>`. */
  usage: string;
  help: string;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Handler<Ctx, R, C> {
  min: number;
  max: number;
  run(ctx: Ctx, positionals: string[], cli: C): R | Promise<R>;
}

/** A command row. Several rows may share a name to describe its forms (see `args`). */
export interface CommandSpec<Ctx = unknown, R = unknown, C = unknown> {
  name: string;
  /** The command's own name plus its positional part, e.g. `deploy <env>`. */
  args?: string;
  summary?: string;
  /** Keys into the app's flag table. */
  flags?: string[];
  /** Children turn this row into a group; a group with a handler is runnable too. */
  commands?: CommandSpec<Ctx, R, C>[];
  /** Child run when no child name follows. */
  default?: string;
  handler?: Handler<Ctx, R, C>;
}

export interface CliSpec<Ctx = unknown, R = unknown, C = unknown> {
  name: string;
  summary: string;
  /** Positional part for a single-command app; commands carry their own `args`. */
  args?: string;
  /** Overrides the derived usage line, in which `[flags]` appears only when the full help lists flags. */
  usage?: string;
  /** Prose block after the pointer line in the full help. */
  intro?: string;
  flags: FlagSpec[];
  commands?: CommandSpec<Ctx, R, C>[];
  /** Command run when none is named. */
  default?: string;
  /** The app's only command, for a tool with no subcommands. */
  handler?: Handler<Ctx, R, C>;
}

export interface ParsedCli {
  /** Resolved command names, outermost first (a default is included). */
  commandPath: string[];
  command?: string;
  /** Every positional as parsed, the command names included. */
  positionals: string[];
  /** Positionals left for the handler, command names removed. */
  args: string[];
  values: Values;
  /** A token that did not name a command. */
  unknown?: string;
  /** Resolution stopped on a group with no runnable fallback. */
  needsChild?: boolean;
  help: boolean;
}

/** A bad invocation: a name, flag or argument mismatch. Exit code 2, not 1. */
export class UsageError extends Error {}

export interface ErrorReport {
  code: number;
  lines: string[];
}

export interface RunOptions<Ctx, R, C> {
  spec: CliSpec<Ctx, R, C>;
  argv: string[];
  /** Shape the app's typed view of the parsed values. May throw `UsageError`. */
  adapt?: (parsed: ParsedCli) => C;
  /** Build the handler context after parsing and before dispatch. */
  context?: (cli: C, parsed: ParsedCli) => Ctx | Promise<Ctx>;
  /** Called for a non-numeric, non-undefined handler result. */
  print?: (result: R, cli: C) => void;
  /** Map an app-specific error to its exit code and output; undefined falls through. */
  mapError?: (error: unknown) => ErrorReport | undefined;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

interface Group<Ctx, R, C> {
  name: string;
  rows: CommandSpec<Ctx, R, C>[];
  flags: string[];
  handler?: Handler<Ctx, R, C>;
  children?: Group<Ctx, R, C>[];
  default?: string;
}

interface Compiled<Ctx, R, C> {
  spec: CliSpec<Ctx, R, C>;
  flagByKey: Map<string, FlagSpec>;
  groups: Group<Ctx, R, C>[];
}

interface Resolution<Ctx, R, C> {
  path: Group<Ctx, R, C>[];
  consumed: number;
  unknown?: string;
  needsChild?: boolean;
}

const USAGE_COL = 40;
const WRAP_COL = 100;

const cache = new WeakMap<object, object>();

/** Compile (and validate) a spec once per object identity. */
function compiledOf<Ctx, R, C>(spec: CliSpec<Ctx, R, C>): Compiled<Ctx, R, C> {
  const key: object = spec;
  const hit = cache.get(key);
  if (hit) return hit as unknown as Compiled<Ctx, R, C>;
  const built = compile(spec);
  cache.set(key, built as unknown as object);
  return built;
}

function compile<Ctx, R, C>(spec: CliSpec<Ctx, R, C>): Compiled<Ctx, R, C> {
  const flagByKey = new Map<string, FlagSpec>();
  for (const flag of spec.flags) {
    if (flagByKey.has(flag.key)) throw new Error(`duplicate flag "${flag.key}"`);
    if (flag.short !== undefined && flag.short.length !== 1) {
      throw new Error(`flag "${flag.key}" has a short name that is not one character`);
    }
    flagByKey.set(flag.key, flag);
  }
  const groups = buildGroups(spec, spec.commands ?? [], flagByKey);
  if (spec.default !== undefined && !groups.some((group) => group.name === spec.default)) {
    throw new Error(`${spec.name}: default command "${spec.default}" is not declared`);
  }
  return { spec, flagByKey, groups };
}

function buildGroups<Ctx, R, C>(
  spec: CliSpec<Ctx, R, C>,
  rows: CommandSpec<Ctx, R, C>[],
  flagByKey: Map<string, FlagSpec>,
): Group<Ctx, R, C>[] {
  const groups: Group<Ctx, R, C>[] = [];
  for (const row of rows) {
    for (const key of row.flags ?? []) {
      if (!flagByKey.has(key)) throw new Error(`unknown flag "${key}" on ${row.name}`);
    }
    const existing = groups.find((group) => group.name === row.name);
    if (!existing) {
      groups.push({ name: row.name, rows: [row], flags: [...new Set(row.flags ?? [])] });
      continue;
    }
    existing.rows.push(row);
    existing.flags = [...new Set([...existing.flags, ...(row.flags ?? [])])];
  }
  for (const group of groups) {
    const handlers = new Set(group.rows.flatMap((row) => (row.handler ? [row.handler] : [])));
    if (handlers.size > 1) throw new Error(`command "${group.name}" has more than one handler`);
    group.handler = handlers.values().next().value;
    const childLists = group.rows.flatMap((row) => (row.commands ? [row.commands] : []));
    if (childLists.length > 0) {
      if (group.rows.length > 1) throw new Error(`command "${group.name}" has forms and subcommands`);
      group.children = buildGroups(spec, childLists[0] ?? [], flagByKey);
    }
    group.default = group.rows.find((row) => row.default)?.default;
    if (group.children) {
      if (group.default !== undefined && !group.children.some((child) => child.name === group.default)) {
        throw new Error(`command "${group.name}": default subcommand "${group.default}" is not declared`);
      }
    } else if (!group.handler) {
      throw new Error(`command "${group.name}" has no handler`);
    }
  }
  return groups;
}

function byName<Ctx, R, C>(groups: Group<Ctx, R, C>[], name: string | undefined): Group<Ctx, R, C> | undefined {
  if (name === undefined) return undefined;
  return groups.find((group) => group.name === name);
}

/**
 * Walk the positional list down the command tree. Lenient: reports, never throws.
 * `defaults` is off for help pages: `--help` on a group shows the group, not its default child.
 */
function resolve<Ctx, R, C>(
  compiled: Compiled<Ctx, R, C>,
  positionals: string[],
  defaults = true,
): Resolution<Ctx, R, C> {
  if (positionals[0] === "help" || compiled.groups.length === 0) {
    return { path: [], consumed: 0 };
  }
  const first = positionals[0];
  const start =
    first === undefined
      ? byName(compiled.groups, defaults ? compiled.spec.default : undefined)
      : byName(compiled.groups, first);
  if (!start) return { path: [], consumed: 0, unknown: first };
  const path = [start];
  let consumed = first === undefined ? 0 : 1;
  let node = start;
  for (;;) {
    if (!node.children || node.children.length === 0) break;
    const next = positionals[consumed];
    if (next !== undefined) {
      const child = byName(node.children, next);
      if (child) {
        path.push(child);
        node = child;
        consumed++;
        continue;
      }
      if (node.handler) break;
      return { path, consumed, unknown: next };
    }
    const fallback = defaults ? byName(node.children, node.default) : undefined;
    if (fallback) {
      path.push(fallback);
      node = fallback;
      continue;
    }
    if (node.handler) break;
    return { path, consumed, needsChild: true };
  }
  return { path, consumed };
}

function optionSpec(flag: FlagSpec): ParseArgsOptionsConfig[string] {
  return {
    type: flag.type,
    ...(flag.short ? { short: flag.short } : {}),
    ...(flag.multiple ? { multiple: true } : {}),
  };
}

function optionsFor<Ctx, R, C>(compiled: Compiled<Ctx, R, C>, path: Group<Ctx, R, C>[]): ParseArgsOptionsConfig {
  const keys = new Set(compiled.spec.flags.filter((flag) => flag.global).map((flag) => flag.key));
  for (const group of path) for (const key of group.flags) keys.add(key);
  const options: ParseArgsOptionsConfig = {};
  for (const key of keys) {
    const flag = compiled.flagByKey.get(key);
    if (flag) options[key] = optionSpec(flag);
  }
  return options;
}

function allOptions<Ctx, R, C>(compiled: Compiled<Ctx, R, C>): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = {};
  for (const flag of compiled.spec.flags) options[flag.key] = optionSpec(flag);
  return options;
}

/** node's "place it after --" advice turns a rejected flag into a positional that fails too. */
function withHelpHint(error: unknown, label: string, appName: string): string {
  const message = (error instanceof Error ? error.message : String(error)).split(". To specify")[0];
  return `${label}: ${message} (${appName} ${label} --help shows its flags)`;
}

/** Strict parse; throws `UsageError` on an unknown flag, a bad value or a misplaced argument. */
export function parseCli<Ctx, R, C>(spec: CliSpec<Ctx, R, C>, argv: string[]): ParsedCli {
  const compiled = compiledOf(spec);
  // A non-strict pass only locates the command path; the strict one parses that path's flags.
  let probe: string[] = [];
  try {
    probe = parseArgs({ args: argv, allowPositionals: true, options: allOptions(compiled), strict: false }).positionals;
  } catch {
    // Malformed before the command; the strict pass reports the real error.
  }
  const found = resolve(compiled, probe);
  const label = found.path.at(-1)?.name ?? probe[0] ?? spec.default ?? spec.name;
  let values: Values = {};
  let positionals: string[] = [];
  try {
    const parsed = parseArgs({ args: argv, allowPositionals: true, options: optionsFor(compiled, found.path) });
    // parseArgs types a repeated option as (string | boolean)[]; `multiple` is only set on strings.
    values = parsed.values as Values;
    positionals = parsed.positionals as string[];
  } catch (error) {
    throw new UsageError(withHelpHint(error, label, spec.name));
  }
  const resolved = resolve(compiled, positionals);
  return {
    commandPath: resolved.path.map((group) => group.name),
    command: resolved.path.at(-1)?.name,
    positionals: positionals.filter((item): item is string => typeof item === "string"),
    args: positionals.slice(resolved.consumed),
    values,
    unknown: resolved.unknown,
    needsChild: resolved.needsChild,
    help: values.help === true,
  };
}

/** Help page for a help invocation (`--help`, `-h`, or `help [command]`), otherwise null. */
export function helpText<Ctx, R, C>(
  spec: CliSpec<Ctx, R, C>,
  query: { help: boolean; positionals: string[] },
): string | null {
  const isHelpCommand = query.positionals[0] === "help";
  if (!query.help && !isHelpCommand) return null;
  const compiled = compiledOf(spec);
  const target = isHelpCommand ? query.positionals.slice(1) : query.positionals;
  if (target.length === 0) return fullHelp(compiled);
  const found = resolve(compiled, target, false);
  if (found.path.length === 0) return fullHelp(compiled);
  return groupHelp(compiled, found.path);
}

function synopsis<Ctx, R, C>(compiled: Compiled<Ctx, R, C>, row: CommandSpec<Ctx, R, C>): string {
  const tokens = [row.args ?? ""];
  for (const key of row.flags ?? []) {
    const flag = compiled.flagByKey.get(key);
    if (flag?.synopsis) tokens.push(flag.synopsis);
  }
  return tokens.filter((token) => token !== "").join(" ");
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

function renderCommand<Ctx, R, C>(compiled: Compiled<Ctx, R, C>, row: CommandSpec<Ctx, R, C>): string {
  const head = `  ${synopsis(compiled, row)}`;
  const lines = wrap(row.summary ?? "", WRAP_COL - USAGE_COL);
  const pad = " ".repeat(USAGE_COL);
  if (head.length < USAGE_COL) {
    if (lines.length === 0) return head;
    return [`${head.padEnd(USAGE_COL)}${lines[0] ?? ""}`, ...lines.slice(1).map((line) => pad + line)].join("\n");
  }
  return [head, ...lines.map((line) => pad + line)].join("\n");
}

function renderCommands<Ctx, R, C>(compiled: Compiled<Ctx, R, C>, groups: Group<Ctx, R, C>[]): string {
  return groups.flatMap((group) => group.rows.map((row) => renderCommand(compiled, row))).join("\n");
}

function renderFlags<Ctx, R, C>(compiled: Compiled<Ctx, R, C>, keys: string[]): string {
  const flags = compiled.spec.flags.filter((flag) => keys.includes(flag.key));
  if (flags.length === 0) return "";
  const col = Math.max(...compiled.spec.flags.map((flag) => flag.usage.length)) + 4;
  return flags
    .map((flag) => {
      const lines = wrap(flag.help, WRAP_COL - col);
      const [first = "", ...rest] = lines;
      return [`  ${flag.usage.padEnd(col)}${first}`, ...rest.map((line) => " ".repeat(col) + line)].join("\n");
    })
    .join("\n");
}

function globalKeys<Ctx, R, C>(compiled: Compiled<Ctx, R, C>): string[] {
  return compiled.spec.flags.filter((flag) => flag.global).map((flag) => flag.key);
}

function usageLine<Ctx, R, C>(compiled: Compiled<Ctx, R, C>): string {
  const spec = compiled.spec;
  if (spec.usage !== undefined) return spec.usage;
  // Advertise flags only when the page lists any: globals for a command app, all flags otherwise.
  if (compiled.groups.length > 0) {
    const flags = spec.flags.some((flag) => flag.global) ? " [flags]" : "";
    return `${spec.name} [<command>] [args]${flags}`;
  }
  const args = spec.args === undefined ? "" : ` ${spec.args}`;
  const flags = spec.flags.length > 0 ? " [flags]" : "";
  return `${spec.name}${args}${flags}`;
}

function section(title: string, body: string): string {
  return `${title}\n${body}`;
}

/** A flags section is omitted when the page has no flags to list. */
function pushFlags<Ctx, R, C>(blocks: string[], compiled: Compiled<Ctx, R, C>, keys: string[]): void {
  const body = renderFlags(compiled, keys);
  if (body !== "") blocks.push("", section("flags:", body));
}

function fullHelp<Ctx, R, C>(compiled: Compiled<Ctx, R, C>): string {
  const spec = compiled.spec;
  const blocks: string[] = [`${spec.name} — ${spec.summary}`, "", `usage: ${usageLine(compiled)}`];
  if (compiled.groups.length > 0) {
    blocks.push("", section("commands:", renderCommands(compiled, compiled.groups)));
    pushFlags(blocks, compiled, globalKeys(compiled));
    blocks.push("", `run ${spec.name} <command> --help for that command's usage and flags.`);
  } else {
    const body = wrap(spec.args ?? "", WRAP_COL);
    if (body.length > 0) blocks.push("", ...body);
    pushFlags(
      blocks,
      compiled,
      spec.flags.map((flag) => flag.key),
    );
  }
  if (spec.intro) blocks.push("", spec.intro);
  return blocks.join("\n").trimEnd();
}

function groupHelp<Ctx, R, C>(compiled: Compiled<Ctx, R, C>, path: Group<Ctx, R, C>[]): string {
  const spec = compiled.spec;
  const group = path.at(-1) as Group<Ctx, R, C>;
  const ancestors = path.slice(0, -1).map((item) => item.name);
  const prefix = [spec.name, ...ancestors].join(" ");
  const usages = group.rows.map((row) => `${prefix} ${synopsis(compiled, row)}`);
  const usage =
    usages.length === 1 ? `usage: ${usages[0]}` : ["usage:", ...usages.map((line) => `  ${line}`)].join("\n");
  const summaries = group.rows.flatMap((row) => wrap(row.summary ?? "", 80));
  const blocks: string[] = [usage];
  if (summaries.length > 0) blocks.push("", ...summaries);
  if (group.children && group.children.length > 0) {
    blocks.push("", section("commands:", renderCommands(compiled, group.children)));
  }
  const keys = [...new Set([...globalKeys(compiled), ...group.flags])];
  pushFlags(blocks, compiled, keys);
  blocks.push("", `run ${spec.name} --help for all commands`);
  return blocks.join("\n").trimEnd();
}

/** Names of every declared command at the top level, once each. */
export function commandNames<Ctx, R, C>(spec: CliSpec<Ctx, R, C>): string[] {
  return compiledOf(spec).groups.map((group) => group.name);
}

/** Names of the top-level commands that carry a handler. */
export function handledNames<Ctx, R, C>(spec: CliSpec<Ctx, R, C>): string[] {
  return compiledOf(spec)
    .groups.filter((group) => group.handler)
    .map((group) => group.name);
}

/** Handler for a top-level command name, or undefined. */
export function handlerOf<Ctx, R, C>(spec: CliSpec<Ctx, R, C>, name: string): Handler<Ctx, R, C> | undefined {
  return compiledOf(spec).groups.find((group) => group.name === name)?.handler;
}

/** Arity problem for a command, or null. One owner so the messages stay uniform. */
export function arityError(label: string, count: number, min: number, max: number): string | null {
  if (count < min) return `${label}: missing argument(s)`;
  if (count > max) return `${label}: too many arguments`;
  return null;
}

function groupsForPath<Ctx, R, C>(compiled: Compiled<Ctx, R, C>, names: string[]): Group<Ctx, R, C>[] {
  const path: Group<Ctx, R, C>[] = [];
  let level = compiled.groups;
  for (const name of names) {
    const group = byName(level, name);
    if (!group) return path;
    path.push(group);
    level = group.children ?? [];
  }
  return path;
}

/**
 * Parse, help, dispatch and exit-code mapping for one invocation.
 *
 * Help wins over dispatch and exits 0. Usage problems exit 2 with the app's help pointer;
 * a handler result that is a number is the exit code; anything else goes to `print`.
 * `mapError` handles app-specific failures, and everything else exits 1 as `error: <message>`.
 */
export async function runCli<Ctx, R, C = ParsedCli>(options: RunOptions<Ctx, R, C>): Promise<number> {
  const { spec } = options;
  const out = options.out ?? ((text: string) => console.log(text));
  const err = options.err ?? ((text: string) => console.error(text));
  const emit = (code: number, lines: string[]): number => {
    for (const line of lines) err(line);
    return code;
  };
  const fail = (error: unknown): number => {
    if (error instanceof UsageError) {
      return emit(2, [`error: ${error.message}`, `(run ${spec.name} --help for usage)`]);
    }
    const mapped = options.mapError?.(error);
    if (mapped) return emit(mapped.code, mapped.lines);
    return emit(1, [`error: ${error instanceof Error ? error.message : String(error)}`]);
  };

  const compiled = compiledOf(spec);
  let parsed: ParsedCli;
  try {
    parsed = parseCli(spec, options.argv);
  } catch (error) {
    return fail(error);
  }
  let cli: C;
  try {
    cli = options.adapt ? options.adapt(parsed) : (parsed as unknown as C);
  } catch (error) {
    return fail(error);
  }
  const help = helpText(spec, parsed);
  if (help !== null) {
    out(help);
    return 0;
  }
  if (parsed.unknown !== undefined) {
    const where = parsed.commandPath.length > 0 ? ` for ${parsed.commandPath.join(" ")}` : "";
    return fail(new UsageError(`unknown command "${parsed.unknown}"${where}`));
  }
  const path = groupsForPath(compiled, parsed.commandPath);
  const group = path.at(-1);
  if (parsed.needsChild) {
    const names = (group?.children ?? []).map((child) => child.name).join("|");
    return fail(new UsageError(`missing subcommand for "${[spec.name, ...parsed.commandPath].join(" ")}": <${names}>`));
  }
  const handler = group?.handler ?? (path.length === 0 ? spec.handler : undefined);
  if (!handler) {
    const name = parsed.positionals[0];
    return fail(new UsageError(name === undefined ? "missing command" : `unknown command "${name}"`));
  }
  const label = group?.name ?? spec.name;
  const arity = arityError(label, parsed.args.length, handler.min, handler.max);
  if (arity) return fail(new UsageError(arity));
  try {
    const ctx = options.context ? await options.context(cli, parsed) : (undefined as Ctx);
    const result = await handler.run(ctx, parsed.args, cli);
    if (typeof result === "number") return result;
    if (result !== undefined) options.print?.(result, cli);
    return 0;
  } catch (error) {
    return fail(error);
  }
}
