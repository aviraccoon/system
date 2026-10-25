/**
 * Facts about the world a classifier cannot read from a command.
 *
 * A command string says what runs, not what it reaches. `docker exec app rm -rf
 * /app/src` and `docker exec app rm -rf /workspaces/app/src` read the same; the
 * second deletes a host directory through a bind mount and the first deletes the
 * container's own layer. This module collects the missing half from the runtime
 * and hands it to the classifier as a short deterministic block appended to the
 * state, so the factor questions can be answered against what is actually there.
 *
 * One rule decides what may go in a block: a fact about the world that the
 * agent's own words cannot author. The command is agent-authored by definition;
 * the container's mounts, its privileged flag and its network come from `docker
 * inspect`. Nothing derived from the conversation or the model belongs here —
 * session intent in the state would be a channel to phrase a call into
 * authorization. For the same reason the question "which container does this
 * command name" is answered by the runtime's own list and a word match, never by
 * a model and never by guessing at a shell grammar.
 *
 * Cost: the runtime is only asked when the command mentions a runtime, so a
 * command that has nothing to do with containers costs one substring check. A
 * mention costs one `docker ps` (names, ids and compose service labels in one
 * call) plus one inspect per container named. Nothing is cached: a container
 * recreated mid-session must not keep its old mounts.
 */
import { type ChildProcess, execFile } from "node:child_process";

const RUNTIME_TIMEOUT_MS = 3000;

/** One path a container mounts from outside its own writable layer. */
export interface ContainerMount {
  /** `bind`, `volume`, `tmpfs`, or whatever the runtime reports. */
  type: string;
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface ContainerFacts {
  name: string;
  image: string;
  /** Container state as the runtime reports it (`running`, `exited`, …). */
  status: string;
  mounts: ContainerMount[];
  privileged: boolean;
  network: string;
}

/** A container as the runtime lists it. */
export interface RunningContainer {
  name: string;
  id: string;
  /** The compose service this container belongs to, when it has one. */
  service?: string;
}

export interface FactsCall {
  toolName: string;
  input: Record<string, unknown>;
}

/** Returns the block a classifier reads, or undefined when nothing is known. */
export type FactsProvider = (call: FactsCall, signal?: AbortSignal) => Promise<string | undefined>;

/** The runtime calls this module makes, injectable so tests do not need docker. */
export interface FactsRuntime {
  list(runtime: string, signal?: AbortSignal): Promise<RunningContainer[]>;
  inspect(runtime: string, name: string, signal?: AbortSignal): Promise<ContainerFacts | null>;
}

export interface RuntimeRun {
  /** Resolves with stdout, or null on failure — including an abort of the signal. */
  promise: Promise<string | null>;
  /** The spawned process; absent only when the runtime could not be started at all. */
  child?: ChildProcess;
}

const RUNTIMES = ["docker", "podman"];

/**
 * Commands whose arguments run somewhere else. A remote `docker exec app ls`
 * names a container the local runtime may also have, and facts about the local
 * one would describe the wrong machine — so a command that uses either tool gets
 * no container facts at all. The cost is a stricter tier on a local exec that
 * shares a command line with a remote one.
 */
const REMOTE_TOOLS = ["ssh", "kubectl"];

/**
 * The Go template `docker inspect` renders, already narrowed to the fields a
 * classifier can use. The full object carries the container's environment,
 * which must not enter the extension process, let alone the state.
 */
const INSPECT_FORMAT =
  '{"mounts":{{json .Mounts}},"privileged":{{.HostConfig.Privileged}},' +
  '"image":{{json .Config.Image}},"status":{{json .State.Status}},' +
  '"network":{{json .HostConfig.NetworkMode}}}';

/** Names, ids and compose service labels in one call. */
const LIST_FORMAT = '{{.Names}}\t{{.ID}}\t{{.Label "com.docker.compose.service"}}';

/** A word in the sense container names use: letters, digits, dot, dash, underscore. */
const WORD_CHAR = "[A-Za-z0-9_.-]";

/** `needle` as a whole command word, so `app-dev-1` does not match `app-dev-10`. */
function wordPattern(needle: string): RegExp {
  return new RegExp(`(?<!${WORD_CHAR})${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!${WORD_CHAR})`);
}

function mentionsWord(command: string, word: string): boolean {
  return wordPattern(word).test(command);
}

/** The runtimes a command mentions; a bare `compose` means docker. */
export function runtimesInCommand(command: string): string[] {
  const found = RUNTIMES.filter((runtime) => command.includes(runtime));
  if (found.length > 0) return found;
  return command.includes("compose") ? ["docker"] : [];
}

/**
 * The containers a command names: by name, by id (full or 12-character prefix),
 * or, for a command that runs through compose, by the service it belongs to.
 * Compose service names are matched only when the command mentions compose, so an
 * ordinary `app` path does not pull in a container.
 */
export function containersInCommand(command: string, containers: RunningContainer[]): RunningContainer[] {
  const composeMentioned = command.includes("compose");
  return containers.filter((container) => {
    if (mentionsWord(command, container.name)) return true;
    if (container.id.length >= 12 && mentionsWord(command, container.id.slice(0, 12))) return true;
    if (container.id && mentionsWord(command, container.id)) return true;
    if (composeMentioned && container.service && mentionsWord(command, container.service)) return true;
    return false;
  });
}

/** Parse `docker ps` listing output (tab-separated name, id, compose service). */
export function parseContainerList(raw: string): RunningContainer[] {
  const containers: RunningContainer[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [name, id, service] = line.split("\t");
    if (!name || !id) continue;
    containers.push({ name, id, service: service || undefined });
  }
  return containers;
}

/** Read one inspect JSON object into facts, or null when the shape is unusable. */
export function parseContainerInspect(name: string, raw: string): ContainerFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const object = parsed as Record<string, unknown>;
  const rawMounts = Array.isArray(object.mounts) ? object.mounts : [];
  const mounts: ContainerMount[] = [];
  for (const entry of rawMounts) {
    if (typeof entry !== "object" || entry === null) continue;
    const mount = entry as Record<string, unknown>;
    if (typeof mount.Destination !== "string") continue;
    mounts.push({
      type: typeof mount.Type === "string" ? mount.Type : "unknown",
      source: typeof mount.Source === "string" ? mount.Source : "",
      destination: mount.Destination,
      readOnly: mount.RW === false,
    });
  }
  return {
    name,
    image: typeof object.image === "string" ? object.image : "unknown",
    status: typeof object.status === "string" ? object.status : "unknown",
    mounts,
    privileged: object.privileged === true,
    network: typeof object.network === "string" ? object.network : "unknown",
  };
}

/** A value rendered on one line: a newline in a mount path must not forge a block line. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The header `formatContainerFacts` writes, and the only thing `hasContainerFacts` matches. */
const CONTAINER_HEADER = /^container .+ from `(?:docker|podman) inspect`:$/m;

/**
 * Whether a facts block carries container facts.
 *
 * The gate reads the `container_local_only` factor only when it does: the factor
 * lowers a tier, and a call whose container was never inspected has nothing to
 * base that on. The match is on text this module generated, never on anything the
 * agent wrote, so a command cannot claim locality for itself.
 */
export function hasContainerFacts(facts: string | undefined): boolean {
  return facts !== undefined && CONTAINER_HEADER.test(facts);
}

/** The block a classifier reads: what the container mounts, and what it is. */
export function formatContainerFacts(facts: ContainerFacts, runtime = "docker"): string {
  const head = `container ${oneLine(facts.name)} (image ${oneLine(facts.image)}, ${oneLine(facts.status)}), from \`${runtime} inspect\`:`;
  const mounts = [...facts.mounts].sort((a, b) => a.destination.localeCompare(b.destination)).map(mountLine);
  const rest =
    mounts.length === 0
      ? "- nothing is mounted from the host; every path the command touches is the container's own writable layer"
      : "- every other path is the container's own writable layer, not a host path";
  const access = facts.privileged ? "privileged: yes" : "not privileged";
  return [head, ...mounts, rest, `- ${access}; ${oneLine(facts.network)} network`].join("\n");
}

function mountLine(mount: ContainerMount): string {
  const access = mount.readOnly ? "read-only" : "read-write";
  const destination = oneLine(mount.destination);
  if (mount.type === "bind") {
    return `- ${destination} is a ${access} bind mount of the host path ${oneLine(mount.source)}`;
  }
  if (mount.type === "volume") {
    return `- ${destination} is a ${access} named volume, stored outside the container`;
  }
  if (mount.type === "tmpfs") {
    return `- ${destination} is a tmpfs mount, kept in memory`;
  }
  return `- ${destination} is a ${access} ${oneLine(mount.type)} mount from ${oneLine(mount.source)}`;
}

/**
 * Run a runtime command and capture stdout; null on failure, including an abort
 * of `signal`. The abort is what bounds a wedged runtime: the child's own timeout
 * is longer than the collection budget, so without it a `pi -p` run would wait for
 * the child after the dialog is answered.
 */
export function runRuntime(binary: string, args: string[], signal?: AbortSignal): RuntimeRun {
  let spawned: ChildProcess | undefined;
  const promise = new Promise<string | null>((resolve) => {
    try {
      spawned = execFile(
        binary,
        args,
        { timeout: RUNTIME_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal },
        (error, stdout) => {
          resolve(error ? null : stdout);
        },
      );
    } catch {
      // execFile validates its arguments before spawning, so a bad argument throws here.
      // Resolve null rather than reject: a runtime failure is "no facts" for every caller,
      // and a rejection would break that contract. A missing binary arrives through the
      // callback instead.
      resolve(null);
    }
  });
  // The executor runs synchronously, so the process exists by the time the promise is
  // constructed. Handing it back is what lets a caller observe that an abort ended the
  // child rather than only the wait for it.
  return { promise, child: spawned };
}

/** `docker inspect` (or podman) for one container. Never throws; null on failure. */
export async function inspectContainerFacts(
  runtime: string,
  name: string,
  signal?: AbortSignal,
): Promise<ContainerFacts | null> {
  const stdout = await runRuntime(runtime, ["inspect", "--format", INSPECT_FORMAT, name], signal).promise;
  return stdout === null ? null : parseContainerInspect(name, stdout.trim());
}

/** The running containers a runtime knows about. Never throws; empty on failure. */
export async function listRunningContainers(runtime: string, signal?: AbortSignal): Promise<RunningContainer[]> {
  const stdout = await runRuntime(runtime, ["ps", "--format", LIST_FORMAT], signal).promise;
  return stdout === null ? [] : parseContainerList(stdout);
}

/** The real runtime, used when no other is injected. */
export const dockerRuntime: FactsRuntime = { list: listRunningContainers, inspect: inspectContainerFacts };

/** Facts for every container a command names, or undefined when it names none. */
export async function containerFactsFor(
  command: string,
  runtime: FactsRuntime = dockerRuntime,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (REMOTE_TOOLS.some((tool) => mentionsWord(command, tool))) return undefined;
  const runtimes = runtimesInCommand(command);
  if (runtimes.length === 0) return undefined;

  const named: Array<{ runtime: string; container: RunningContainer }> = [];
  for (const name of runtimes) {
    const listed = await runtime.list(name, signal).catch(() => []);
    for (const container of containersInCommand(command, listed)) named.push({ runtime: name, container });
  }
  if (named.length === 0) return undefined;

  const blocks = await Promise.all(
    named.map(async ({ runtime: name, container }) => {
      const facts = await runtime.inspect(name, container.name, signal).catch(() => null);
      return facts ? formatContainerFacts(facts, name) : undefined;
    }),
  );
  const text = blocks.filter((block): block is string => Boolean(block)).join("\n\n");
  return text || undefined;
}

/** The provider this module contributes: container facts for a bash call. */
export const containerFacts: FactsProvider = ({ toolName, input }, signal) => {
  if (toolName !== "bash") return Promise.resolve(undefined);
  const command = input.command;
  return typeof command === "string" ? containerFactsFor(command, dockerRuntime, signal) : Promise.resolve(undefined);
};

/** Providers that run for every gated call. */
export const FACTS_PROVIDERS: FactsProvider[] = [containerFacts];

/**
 * How long the gate waits for facts before classifying without them. The runtime
 * calls have their own timeout, but a wedged daemon would stack them in front of
 * the confirmation dialog; facts are evidence, so a budget that runs out simply
 * means the stricter tier.
 */
export const FACTS_BUDGET_MS = 1500;

/**
 * Collect every provider's block for one call, joined by a blank line. A provider
 * that fails contributes nothing: facts are evidence, and a missing block must
 * leave the classifier with what it has rather than refuse the call.
 */
export async function collectFacts(
  call: FactsCall,
  providers: FactsProvider[] = FACTS_PROVIDERS,
  budgetMs = FACTS_BUDGET_MS,
): Promise<string | undefined> {
  const controller = new AbortController();
  const collected = Promise.all(
    providers.map((provider) => provider(call, controller.signal).catch(() => undefined)),
  ).then((blocks) => {
    const text = blocks.filter((block): block is string => Boolean(block)).join("\n\n");
    return text || undefined;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
  });
  try {
    return await Promise.race([collected, expired]);
  } finally {
    // Abort the providers, not just this race: a live child outlives it.
    clearTimeout(timer);
    controller.abort();
  }
}
