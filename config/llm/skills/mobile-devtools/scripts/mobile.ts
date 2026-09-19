#!/usr/bin/env bun
/**
 * mobile — observe and act on iOS simulators, Android emulators/devices, and (read-only)
 * physical iPhones.
 *
 *   mobile devices [--json]                            list every target
 *   mobile ui [--device D] [--json]                    screen outline with @N refs
 *   mobile tap @N | X,Y | --label "Text" [--device D]  act
 *   mobile shot [--out FILE] [--device D]              screenshot (also on physical phones)
 *   mobile sim start --project PATH [--device NAME]    open the project + start a session
 *   mobile sim end                                     close the session (they are expensive)
 *
 * Backends:
 *   iOS simulator   Xcode 27 MCP tools through `xcrun mcpbridge` (hierarchy, taps, typing,
 *                   screenshots). Simulator-only: Apple refuses physical devices for these.
 *   Android         Google's `android` CLI (`layout`, `screen capture`) + `adb shell input`.
 *   physical iOS    `xcrun devicectl` — screenshots only; no interaction channel exists.
 *
 * Rules baked in: every foreground call is capped at ~10 s, refs from the last `ui` are
 * cached on disk (visible and inspectable), and unsupported verb/target combinations fail
 * with the reason plus the nearest alternative.
 *
 * State lives in $XDG_CACHE_HOME/mobile: state.json, refs-<device>.json,
 * outline-<device>.txt, mcp-reply.jsonl (raw last reply, for debugging).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const BRIDGE_WAIT_MS = 10_000;
const SH_TIMEOUT_S = 15;
const CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "mobile");
const STATE_FILE = join(CACHE, "state.json");
const NOISE_TYPES = new Set(["Other", "Window", "Application", "WebView", "Image", "ScrollBar"]);

mkdirSync(CACHE, { recursive: true });

class MobileError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

// ---------------------------------------------------------------- shell

type ShResult = { code: number; stdout: string; stderr: string };

function sh(cmd: string[]): ShResult {
  // Bound every shell-out: a wedged emulator or a phone that dropped off the network would
  // otherwise hang the caller indefinitely.
  const proc = Bun.spawnSync(["timeout", String(SH_TIMEOUT_S), ...cmd], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function shOrThrow(cmd: string[]): string {
  const result = sh(cmd);
  if (result.code !== 0) {
    throw new MobileError(`${cmd.join(" ")} failed`, result.stderr.trim() || undefined);
  }
  return result.stdout;
}

function adbBin(): string {
  const adb = Bun.which("adb");
  if (adb) return adb;
  const fallback = join(homedir(), "Library/Android/sdk/platform-tools/adb");
  if (existsSync(fallback)) return fallback;
  throw new MobileError("adb not found", "install Android platform-tools or start an emulator");
}

// ---------------------------------------------------------------- state

type State = { simProject?: string; simSession?: string; simWorkspace?: string; device?: string };

function loadState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch (err) {
    console.error(`mobile: ignoring unreadable state file ${STATE_FILE}:`, err);
    return {};
  }
}

function saveState(patch: Partial<State>): void {
  writeFileSync(STATE_FILE, `${JSON.stringify({ ...loadState(), ...patch }, null, 2)}\n`);
}

// ---------------------------------------------------------------- MCP bridge

/** Resolve with undefined after `ms` — used to bound reads. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, Bun.sleep(ms).then(() => undefined)]);
}

async function mcpCall(tool: string, args: unknown): Promise<unknown> {
  // Xcode keys agent trust to the process that *launched* mcpbridge, and records it by path
  // and hash. Launch through coreutils' `timeout` so the identity stays stable (and bounded)
  // instead of changing with whichever interpreter ran this script; approve it once in Xcode
  // if the prompt appears (Settings → Intelligence → External Agent Access).
  const proc = Bun.spawn(["timeout", `${Math.ceil(BRIDGE_WAIT_MS / 1000) + 5}`, "xcrun", "mcpbridge"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: unknown) => proc.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mobile", version: "1" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
  await proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + BRIDGE_WAIT_MS;
  const raw: string[] = [];
  let buffer = "";
  let reply: unknown;
  try {
    while (Date.now() < deadline && reply === undefined) {
      const chunk = await withTimeout(reader.read(), Math.max(1, deadline - Date.now()));
      if (!chunk || chunk.done) break;
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        raw.push(line);
        try {
          const message = JSON.parse(line) as { id?: number };
          if (message.id === 2) reply = message;
        } catch (err) {
          console.error(`mobile: unparsable reply line from ${tool}:`, err);
        }
      }
    }
  } finally {
    reader.releaseLock();
    proc.kill();
  }
  if (buffer.trim()) raw.push(buffer);
  writeFileSync(join(CACHE, "mcp-reply.jsonl"), `${raw.join("\n")}\n`);

  if (reply === undefined) {
    throw new MobileError(
      `Xcode did not answer ${tool} within ${BRIDGE_WAIT_MS / 1000}s`,
      "check `xcrun mcp-server status`; a simulator that is still booting needs a retry",
    );
  }
  const result = (
    reply as { result?: { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] } }
  ).result;
  if (result?.isError) throw new MobileError(result.content?.[0]?.text ?? `${tool} failed`);
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  throw new MobileError(`${tool} returned nothing`);
}

type SessionStart = { interactionSessionKey?: string; deviceUUID?: string };
type Capture = { applicationState?: string; hierarchyPath?: string; screenshotPath?: string };

// ---------------------------------------------------------------- targets

type Kind = "sim" | "android" | "device";
type Verb = "ui" | "tap" | "shot";
type Target = { kind: Kind; id: string; label: string; capabilities: Set<Verb> };

const CAPABILITIES: Record<Kind, Set<Verb>> = {
  sim: new Set<Verb>(["ui", "tap", "shot"]),
  android: new Set<Verb>(["ui", "tap", "shot"]),
  device: new Set<Verb>(["shot"]),
};

const NEAREST_ALTERNATIVE: Record<Kind, string> = {
  sim: "a booted simulator accepts ui/tap/shot",
  android: "an Android device accepts ui/tap/shot",
  device: "physical iPhones only support `mobile shot`; interaction needs an XCUITest or WebDriverAgent harness",
};

function bootedSimulators(): { name: string; udid: string }[] {
  const out = sh(["xcrun", "simctl", "list", "devices", "booted"]);
  if (out.code !== 0) return [];
  return out.stdout
    .split("\n")
    .map((line) => line.match(/^\s+(.*) \(([0-9A-Fa-f-]{36})\) \(Booted\)\s*$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ name: (match[1] ?? "").trim(), udid: match[2] ?? "" }))
    .filter((sim) => sim.udid !== "");
}

function androidDevices(): { serial: string; model: string }[] {
  let adb: string;
  try {
    adb = adbBin();
  } catch {
    return [];
  }
  const out = sh([adb, "devices", "-l"]);
  if (out.code !== 0) return [];
  return out.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.match(/^(\S+)\s+device\b/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => {
      const serial = match[1] ?? "";
      const line = out.stdout.split("\n").find((candidate) => candidate.trimStart().startsWith(`${serial} `)) ?? "";
      return { serial, model: line.match(/model:(\S+)/)?.[1] ?? "" };
    })
    .filter((device) => device.serial !== "");
}

function physicalDevices(): { name: string; udid: string }[] {
  const out = sh(["xcrun", "devicectl", "list", "devices", "--json-output", "-"]);
  if (out.code !== 0) return [];
  try {
    const parsed = JSON.parse(out.stdout) as {
      result?: {
        devices?: {
          deviceProperties?: { name?: string };
          hardwareProperties?: { udid?: string };
          properties?: { hardware?: { reality?: string; udid?: string }; state?: { name?: string } };
        }[];
      };
    };
    // devicectl lists simulated devices too; only "physical" belongs on the devicectl path.
    return (parsed.result?.devices ?? [])
      .map((device) => ({
        name: device.properties?.state?.name ?? device.deviceProperties?.name ?? "",
        udid: device.properties?.hardware?.udid ?? device.hardwareProperties?.udid ?? "",
        reality: device.properties?.hardware?.reality ?? "physical",
      }))
      .filter((device) => device.reality === "physical" && device.name.length > 0)
      .map(({ name, udid }) => ({ name, udid }));
  } catch (err) {
    console.error("mobile: could not parse devicectl output:", err);
    return [];
  }
}

function resolveTarget(deviceArg?: string): Target {
  const want = deviceArg ?? loadState().device;
  if (want) {
    const droid = androidDevices().find((device) => device.serial === want);
    if (droid) {
      return {
        kind: "android",
        id: droid.serial,
        label: droid.model || droid.serial,
        capabilities: CAPABILITIES.android,
      };
    }
    const sim = bootedSimulators().find((device) => device.udid === want || device.name === want);
    if (sim) return { kind: "sim", id: sim.udid, label: sim.name, capabilities: CAPABILITIES.sim };
    const phone = physicalDevices().find((device) => device.name === want || device.udid === want);
    if (phone) return { kind: "device", id: phone.name, label: phone.name, capabilities: CAPABILITIES.device };
    throw new MobileError(`unknown device '${want}'`, "run `mobile devices`");
  }
  const sim = bootedSimulators()[0];
  if (sim) {
    saveState({ device: sim.name });
    return { kind: "sim", id: sim.udid, label: sim.name, capabilities: CAPABILITIES.sim };
  }
  const droid = androidDevices()[0];
  if (droid) {
    saveState({ device: droid.serial });
    return {
      kind: "android",
      id: droid.serial,
      label: droid.model || droid.serial,
      capabilities: CAPABILITIES.android,
    };
  }
  const phone = physicalDevices()[0];
  if (phone) {
    saveState({ device: phone.name });
    return { kind: "device", id: phone.name, label: phone.name, capabilities: CAPABILITIES.device };
  }
  throw new MobileError(
    "no device available",
    "boot a simulator (`xcrun simctl boot <device>`) or start an emulator (`android emulator start <avd>`)",
  );
}

function requireCapability(target: Target, verb: Verb): void {
  if (target.capabilities.has(verb)) return;
  throw new MobileError(
    `${target.kind} '${target.label}' does not support '${verb}'`,
    NEAREST_ALTERNATIVE[target.kind],
  );
}

// ---------------------------------------------------------------- outline

type Element = { type: string; label: string; x: number; y: number };
type Refs = Record<string, Element>;
type Outline = { header: string; elements: Element[] };

function refsPath(target: Target): string {
  return join(CACHE, `refs-${target.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

function outlinePath(target: Target): string {
  return join(CACHE, `outline-${target.id.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`);
}

function writeRefs(target: Target, elements: Element[]): void {
  const refs: Refs = {};
  elements.forEach((element, index) => {
    refs[String(index + 1)] = element;
  });
  writeFileSync(refsPath(target), `${JSON.stringify(refs, null, 2)}\n`);
}

function dedupe(elements: Element[]): Element[] {
  const seen = new Set<string>();
  return elements.filter((element) => {
    const key = `${element.type}|${element.label}|${element.x}|${element.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** SF Symbols and Material icons arrive as private-use glyphs; show them as escapes so an
 * agent can tell an icon from an empty label (and address it by its ref). */
function cleanLabel(label: string): string {
  let clean = "";
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xe000 && code <= 0xf8ff) clean += `<U+${code.toString(16).toUpperCase()}>`;
    else if (code < 0x20 || code === 0x7f) clean += " ";
    else clean += char;
  }
  return clean.trim();
}

function printOutline(target: Target, outline: Outline): void {
  const lines: string[] = [outline.header];
  outline.elements.forEach((element, index) => {
    const ref = String(index + 1);
    lines.push(`@${ref.padEnd(3)} ${element.type.padEnd(14)} "${element.label}" (${element.x},${element.y})`);
  });
  if (outline.elements.length === 0) {
    lines.push("  (no labelled elements — look at a screenshot: mobile shot)");
  }
  // Always persist, even when empty: stale refs from a previous screen are worse than none.
  writeRefs(target, outline.elements);
  writeFileSync(outlinePath(target), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

function parseAppleHierarchy(text: string): Element[] {
  const elements: Element[] = [];
  for (const line of text.split("\n")) {
    const hit = line.match(/hitPoint: \{(-?[\d.]+), (-?[\d.]+)\}/);
    const type = line.trim().match(/^([A-Za-z]+),/)?.[1];
    if (!hit || !type || NOISE_TYPES.has(type)) continue;
    const label =
      line.match(/label: '([^']+)'/)?.[1] ??
      line.match(/placeholderValue: '([^']+)'/)?.[1] ??
      line.match(/value: ([^,]+),/)?.[1] ??
      "";
    if (!label.trim()) continue;
    elements.push({
      type,
      label: cleanLabel(label),
      x: Math.round(Number(hit[1] ?? 0)),
      y: Math.round(Number(hit[2] ?? 0)),
    });
  }
  return dedupe(elements).slice(0, 80);
}

type AndroidNode = {
  class?: string;
  text?: string;
  contentDesc?: string;
  center?: number[] | string;
  children?: unknown;
  "off-screen"?: boolean;
};

/** `center` is either [x, y] or the string "[x,y]", depending on the CLI build. */
function androidPoint(center: AndroidNode["center"]): { x: number; y: number } | undefined {
  if (Array.isArray(center) && center.length >= 2) {
    return { x: Math.round(Number(center[0] ?? 0)), y: Math.round(Number(center[1] ?? 0)) };
  }
  if (typeof center === "string") {
    const match = center.match(/\[\s*(-?\d+)\s*,\s*(-?\d+)\s*\]/);
    if (match) return { x: Number(match[1]), y: Number(match[2]) };
  }
  return undefined;
}

function parseAndroidLayout(text: string): Element[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error("mobile: android layout returned unparsable JSON:", err);
    return [];
  }
  const elements: Element[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as AndroidNode;
    // Off-screen nodes still carry a coordinate; tapping it would hit something else.
    if (record["off-screen"] === true) return;
    const label = cleanLabel(record.text ?? record.contentDesc ?? "");
    const point = androidPoint(record.center);
    if (point && label) {
      elements.push({
        type: (record.class ?? "View").split(".").pop() ?? "View",
        label,
        x: point.x,
        y: point.y,
      });
    }
    if (record.children !== undefined) walk(record.children);
  };
  walk(parsed);
  return dedupe(elements).slice(0, 80);
}

// ---------------------------------------------------------------- sim backend

async function startSession(): Promise<string> {
  const project = loadState().simProject;
  if (!project) {
    throw new MobileError(
      "no simulator session and no project on record",
      "mobile sim start --project /path/App.xcodeproj",
    );
  }
  const session = await cmdSimStart(project);
  return session.interactionSessionKey ?? "";
}

async function simCapture(command: string): Promise<Capture> {
  // `||`, not `??`: cmdSimEnd writes an empty string, which `??` would treat as a live session.
  let session = loadState().simSession || (await startSession());
  try {
    return (await captureWith(session, command)) as Capture;
  } catch (err) {
    // Sessions die with the Xcode service and expire on their own; one silent restart beats
    // making the caller re-run `sim start` every time that happens. Keep the old key when the
    // restart fails — it is still the handle on the live session.
    if (!(err instanceof MobileError) || !/session not found/i.test(err.message)) throw err;
    let restarted: string;
    try {
      restarted = await startSession();
    } catch (startErr) {
      if (startErr instanceof MobileError && /already in use/i.test(startErr.message)) {
        throw new MobileError(
          `a previous session still holds the device: ${startErr.message}`,
          `its key is still in ${STATE_FILE} — end that session from Xcode, then retry`,
        );
      }
      throw startErr;
    }
    session = restarted;
    return (await captureWith(session, command)) as Capture;
  }
}

function captureWith(session: string, command: string): Promise<unknown> {
  return mcpCall("DeviceInteractionSynthesize", { interactSessionKey: session, interactionCommand: command });
}

async function listWorkspace(): Promise<string | undefined> {
  const workspaces = (await mcpCall("XcodeListWorkspaces", {})) as { message?: string };
  return workspaces?.message?.match(/workspaceIdentifier: ([^,]+),/)?.[1];
}

async function cmdSimStart(project: string, device?: string): Promise<SessionStart> {
  if (!project) throw new MobileError("specify --project /path/to/App.xcodeproj");
  if (!existsSync(project)) throw new MobileError(`project not found: ${project}`);
  saveState({ simProject: project });
  const status = sh(["xcrun", "mcp-server", "status", "--format", "json"]);
  if (!status.stdout.includes('"running" : true')) sh(["xcrun", "mcp-server", "open", project]);
  // Workspace identifiers change when the Xcode service restarts, so a cached one is never
  // reused: list, re-open once if the list is empty, and give up rather than pass a stale id.
  let ws = await listWorkspace();
  if (!ws) {
    sh(["xcrun", "mcp-server", "open", project]);
    Bun.sleepSync(1000);
    ws = await listWorkspace();
  }
  if (!ws) throw new MobileError("no workspace open in Xcode's MCP service", `xcrun mcp-server open ${project}`);
  saveState({ simWorkspace: ws });
  const args: Record<string, string> = {
    sessionIdentifier: `Mobile ${new Date().toISOString()}`,
    workspaceIdentifier: ws,
  };
  // Default to a booted simulator by name: the session tool would otherwise follow Xcode's
  // current run destination, which may be a physical device (unsupported for interaction).
  const target = device ?? bootedSimulators()[0]?.name;
  if (target) args.deviceIdentifier = target;
  const session = (await mcpCall("DeviceInteractionStartWorkspaceSession", args)) as SessionStart;
  if (!session?.interactionSessionKey) throw new MobileError("session did not start");
  saveState({ simSession: session.interactionSessionKey });
  return session;
}

async function cmdSimEnd(): Promise<void> {
  const session = loadState().simSession;
  if (!session) {
    console.log("no session");
    return;
  }
  await mcpCall("DeviceInteractionEndSession", { interactionSessionKey: session });
  saveState({ simSession: "" });
  console.log(`session ended: ${session}`);
}

async function simOutline(target: Target): Promise<Outline> {
  const capture = await simCapture("");
  if (!capture.hierarchyPath || !existsSync(capture.hierarchyPath)) {
    throw new MobileError("capture returned no hierarchy file");
  }
  return {
    header: `iOS Simulator ${target.label}`,
    elements: parseAppleHierarchy(readFileSync(capture.hierarchyPath, "utf8")),
  };
}

async function simTap(x: number, y: number): Promise<void> {
  await simCapture(`t ${x} ${y}`);
  console.log(`tapped ${x},${y}`);
}

// ---------------------------------------------------------------- android backend

function androidOutline(target: Target): Outline {
  const dir = shOrThrow(["mktemp", "-d"]).trim();
  const file = join(dir, "layout.json");
  try {
    let result = sh(["android", "layout", "--pretty", "--device", target.id, "-o", file]);
    // The layout bridge fails transiently right after a screen change (its own docs blame
    // WebViews and animations), so one retry covers it.
    if (result.code !== 0 || !existsSync(file)) {
      Bun.sleepSync(500);
      result = sh(["android", "layout", "--pretty", "--device", target.id, "-o", file]);
    }
    if (result.code !== 0 || !existsSync(file)) {
      throw new MobileError(
        `android layout failed (exit ${result.code})`,
        result.stderr.trim() || result.stdout.trim() || "is the app running and the emulator up?",
      );
    }
    return { header: `app: Android ${target.label}`, elements: parseAndroidLayout(readFileSync(file, "utf8")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function androidTap(target: Target, x: number, y: number): void {
  shOrThrow([adbBin(), "-s", target.id, "shell", "input", "tap", String(x), String(y)]);
  console.log(`tapped ${x},${y}`);
}

// ---------------------------------------------------------------- verbs

function readRefs(target: Target): Refs {
  const file = refsPath(target);
  if (!existsSync(file)) throw new MobileError(`no refs cached for '${target.label}'`, "run `mobile ui` first");
  return JSON.parse(readFileSync(file, "utf8")) as Refs;
}

/** `@N`, `X,Y`, or a unique label substring -> point. */
function resolvePoint(spec: string, target: Target): { x: number; y: number } {
  const ref = spec.startsWith("@") ? readRefs(target)[spec.slice(1)] : undefined;
  if (spec.startsWith("@")) {
    if (!ref) throw new MobileError(`no ref ${spec}`, "re-run `mobile ui` — refs change between captures");
    return { x: ref.x, y: ref.y };
  }
  const point = spec.match(/^(\d+),(\d+)$/);
  if (point) return { x: Number(point[1]), y: Number(point[2]) };
  const query = spec.toLowerCase();
  const matches = Object.entries(readRefs(target)).filter(([, element]) => element.label.toLowerCase().includes(query));
  if (matches.length === 0) throw new MobileError(`no element matching '${spec}'`, "re-run `mobile ui`");
  if (matches.length > 1) {
    const list = matches.map(([key, element]) => `@${key} "${element.label}"`).join(", ");
    throw new MobileError(`'${spec}' matches ${matches.length} elements: ${list}`, "use a @ref or a longer label");
  }
  const element = matches[0]?.[1];
  if (!element) throw new MobileError(`no element matching '${spec}'`, "re-run `mobile ui`");
  return { x: element.x, y: element.y };
}

async function elementsFor(target: Target): Promise<Element[]> {
  if (target.kind === "android") return androidOutline(target).elements;
  return (await simOutline(target)).elements;
}

function cmdDevices(json: boolean): void {
  const sims = bootedSimulators();
  const droids = androidDevices();
  const phones = physicalDevices();
  if (json) {
    console.log(JSON.stringify({ simulators: sims, android: droids, physical: phones }, null, 2));
    return;
  }
  console.log("iOS simulators (booted):");
  console.log(sims.length ? sims.map((sim) => `  ${sim.name} ${sim.udid}`).join("\n") : "  (none booted)");
  console.log("Android:");
  console.log(droids.length ? droids.map((droid) => `  ${droid.serial} ${droid.model}`).join("\n") : "  (none)");
  console.log("Physical iOS (screenshot only):");
  console.log(phones.length ? phones.map((phone) => `  ${phone.name} ${phone.udid}`).join("\n") : "  (none)");
}

async function cmdUi(target: Target, json: boolean): Promise<void> {
  requireCapability(target, "ui");
  if (json) {
    const elements = await elementsFor(target);
    console.log(JSON.stringify({ device: target.label, kind: target.kind, elements }, null, 2));
    writeRefs(target, elements);
    return;
  }
  printOutline(target, target.kind === "android" ? androidOutline(target) : await simOutline(target));
}

async function cmdTap(target: Target, spec: string): Promise<void> {
  requireCapability(target, "tap");
  const { x, y } = resolvePoint(spec, target);
  if (target.kind === "sim") await simTap(x, y);
  else androidTap(target, x, y);
}

async function cmdShot(target: Target, out?: string): Promise<void> {
  requireCapability(target, "shot");
  if (target.kind === "sim") {
    const capture = await simCapture("");
    if (!capture.screenshotPath) throw new MobileError("capture returned no screenshot");
    if (out) {
      copyFileSync(capture.screenshotPath, out);
      console.log(out);
    } else {
      console.log(capture.screenshotPath);
    }
    return;
  }
  const path = out ?? `/tmp/${target.kind}-${Date.now()}.png`;
  if (target.kind === "android") {
    shOrThrow(["android", "screen", "capture", "--device", target.id, "-o", path]);
  } else {
    shOrThrow(["xcrun", "devicectl", "device", "capture", "screenshot", "--device", target.id, "--destination", path]);
  }
  console.log(path);
}

// ---------------------------------------------------------------- main

function usage(): void {
  console.log(`mobile — observe and act on simulators, emulators and (screenshot-only) phones

  mobile devices [--json]                            list every target
  mobile ui [--device D] [--json]                    screen outline with @N refs
  mobile tap @N | X,Y | --label "Text" [--device D]  tap a ref, a point, or a unique label
  mobile shot [--out FILE] [--device D]              screenshot (also on physical phones)
  mobile sim start --project PATH [--device NAME]    open the project + start a session
  mobile sim end                                     close the sim session

  --device takes a simulator name/UDID, an adb serial, or a devicectl device name.
  Default: first booted simulator, else Android, else a physical iPhone.
  Build and install with the project's own tooling first.`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      device: { type: "string", short: "d" },
      out: { type: "string", short: "o" },
      label: { type: "string", short: "l" },
      project: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) return usage();

  switch (command) {
    case "devices":
      return cmdDevices(values.json);
    case "sim": {
      if (rest[0] === "start") {
        const session = await cmdSimStart(values.project ?? rest[1] ?? "", values.device);
        console.log(`session: ${session.interactionSessionKey} device: ${session.deviceUUID ?? "current"}`);
        return;
      }
      if (rest[0] === "end") return cmdSimEnd();
      throw new MobileError("usage: mobile sim start --project PATH | mobile sim end");
    }
    case "ui":
      return cmdUi(resolveTarget(values.device), values.json);
    case "tap": {
      const spec = values.label ?? rest[0];
      if (!spec) throw new MobileError("specify @N, X,Y or --label TEXT");
      return cmdTap(resolveTarget(values.device), spec);
    }
    case "shot":
      return cmdShot(resolveTarget(values.device), values.out);
    default:
      throw new MobileError(`unknown command '${command}'`, "run `mobile --help`");
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof MobileError) {
    console.error(`mobile: ${err.message}`);
    if (err.hint) console.error(`  hint: ${err.hint}`);
  } else {
    console.error("mobile: unexpected failure:", err);
  }
  process.exit(1);
}
