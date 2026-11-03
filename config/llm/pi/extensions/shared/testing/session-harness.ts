/**
 * In-process session harness: a real `AgentSession` with a scripted model.
 *
 * The point is that nothing about pi is faked. Extensions load through the real loader, the real
 * runner dispatches every event in the real order (`agent_end` before `agent_settled`), tools the
 * extension registers are the ones that run, and `ctx` is the session's own. Only the model and the UI
 * are scripted; see `ui`.
 *
 * Why not a fake `ExtensionAPI`: a fake duplicates the host to approximate it, and a pin written
 * against the approximation passes for reasons that do not hold in a session. `modelContexts` is what
 * lets a test assert what the model actually saw.
 *
 * Isolation is per instance, with one exception named below (pi's theme singleton), because a
 * shared-process test runner makes every other global a leak between files:
 *
 * - The session gets its own temp `agentDir`, cwd and credential store, so its `auth.json` and
 *   `models.json` are nowhere near `~/.pi/agent`; the explicit runtime goes further and reads no
 *   `models.json` at all, keeps the model store in memory, and skips the catalog refresh, so the run
 *   neither reads the host's model definitions nor reaches the network for them.
 * - Extension discovery is off and the agent directory and settings are empty, so only the factories a
 *   test passes can load.
 * - `process.env` is never touched, so two harnesses can coexist and `cleanup()` leaves nothing behind
 *   but a deleted temp root. The one process-wide value the harness sets is pi's theme singleton, which
 *   a real session's startup sets too (`initTheme`); it is read-only from then on.
 *
 * Type safety, and its limit. Everything this file builds against pi is checked against pi's own types
 * instead of cast: the tool calls are `ToolCall`, the assistant turns are `AssistantMessage`, the stream
 * events are `AssistantMessageEvent`, the provider config is checked by `pi.registerProvider` itself,
 * the UI is `satisfies ExtensionUIContext`, and the theme is pi's real one. The one cast is the
 * scripted dialog answer, because `custom<T>` cannot type what a test hands it. So a pi release that
 * adds a required field, renames a method or narrows a type fails `tsc` here rather than at runtime
 * inside a test. What types cannot catch is behaviour: whether `session_start` is emitted at all,
 * whether `agent_end` precedes `agent_settled`, what `prompt()` waits for. Those are pinned by this
 * file's own test, which is the only kind of check that fails when pi changes the sequence.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  type Model,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  type ExtensionUIContext,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";

/** Prefix of every temp root the harness creates; a test can look for leftovers without copying it. */
export const HARNESS_ROOT_PREFIX = "pi-harness-";

const FAUX_PROVIDER = "faux";
const FAUX_MODEL_ID = "faux-1";
const FAUX_API = "anthropic-messages" as const;

/** One scripted assistant turn. A bare string is shorthand for `{ text }`. */
export interface ScriptedResponse {
  text?: string;
  /** Tool calls the model makes this turn; execution is real. `id` is generated when omitted. */
  toolCalls?: Array<Omit<ToolCall, "type" | "id"> & { id?: string }>;
  /** The turn fails with this message. A run rejects when its last turn is one of these. */
  error?: string;
}

export interface HarnessOptions {
  /** Extension factories to load, in order, after the harness's own provider. */
  extensions?: ExtensionFactory[];
  /** Responses the model cycles through. Default: one `"ok"`. */
  responses?: Array<ScriptedResponse | string>;
  /** Active tools (an allowlist). Default: pi's defaults plus every extension tool. */
  tools?: string[];
  /** Session cwd. Default: a temp directory inside the harness root. */
  cwd?: string;
  /** Settings for the run; see `SettingsManager.inMemory` for the shape. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /**
   * UI context: `{}` records toasts and footer status and answers dialogs with the safe-side
   * defaults; `false` binds pi's no-op UI context, as a print-mode parent does, so `ctx.hasUI` is false
   * and `ctx.ui` does nothing. A custom component with no scripted answer throws, because there is no
   * terminal to draw it in.
   */
  ui?: false | HarnessAnswers;
}

/** Answers for `ctx.ui` dialogs, consumed in order. A missing answer falls back to the safe side. */
export interface HarnessAnswers {
  select?: string[];
  confirm?: boolean[];
  input?: string[];
  editor?: string[];
  custom?: unknown[];
}

/** A dialog the run opened, with the content it asked for rather than only its title. */
export type HarnessDialog =
  | { kind: "select"; title: string; options: string[] }
  | { kind: "confirm" | "input" | "editor"; title: string; message: string }
  | { kind: "custom" };

/** What the run told the user, recorded instead of rendered. */
export interface HarnessUIState {
  notifications: Array<{ message: string; type: "info" | "warning" | "error" }>;
  statuses: Array<{ key: string; text: string | undefined }>;
  dialogs: HarnessDialog[];
  /** Last text set for a footer key, as it was written; `plain()` strips the theme's codes. */
  status(key: string): string | undefined;
}

export interface ToolResultRecord {
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface Harness {
  session: AgentSession;
  /** What the run told the user, or undefined when the harness bound no UI. */
  ui: HarnessUIState | undefined;
  /** Session cwd (a temp directory unless one was passed). */
  cwd: string;
  /** Temp root holding the agent directory and, unless one was passed, the session cwd. */
  root: string;
  /** Every session event, in order. */
  events: AgentSessionEvent[];
  eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
  /** Every context handed to the scripted model, in order. */
  modelContexts: TranscriptContext[];
  /** How many times the scripted model was called. */
  modelCalls(): number;
  /** Tool results in order, as the session saw them. */
  toolResults(): ToolResultRecord[];
  /** Assistant text of the last turn. */
  lastText(): string | undefined;
  /**
   * Run one prompt to completion: pi resolves after retries and queued work, and this rejects when the
   * run's last turn failed, which `prompt` alone would report as a normal return.
   */
  run(text: string): Promise<void>;
  /**
   * Resolve with the first event matching `match` that arrives after this call. Rejects after
   * `timeoutMs` rather than hanging a suite. Pass `includePast` to also match an event that already
   * arrived, which is only right when the predicate names one thing (a job id, a message type).
   */
  waitForEvent(
    match: (event: AgentSessionEvent) => boolean,
    options?: { timeoutMs?: number; description?: string; includePast?: boolean },
  ): Promise<AgentSessionEvent>;
  /** Dispose the session and delete the temp root. */
  cleanup(): void;
}

let toolCallIdCounter = 0;

function normalize(response: ScriptedResponse | string): ScriptedResponse {
  return typeof response === "string" ? { text: response } : response;
}

/** The reasons a scripted turn can end with, which is what the stream can carry. */
type ScriptedReason = "stop" | "toolUse" | "error";

function buildMessage(response: ScriptedResponse): { message: AssistantMessage; reason: ScriptedReason } {
  const content: AssistantMessage["content"] = [];
  if (response.text !== undefined) content.push({ type: "text", text: response.text });
  for (const call of response.toolCalls ?? []) {
    content.push({
      type: "toolCall",
      id: call.id ?? `faux_call_${++toolCallIdCounter}`,
      name: call.name,
      arguments: call.arguments,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const reason: ScriptedReason = response.error
    ? "error"
    : response.toolCalls && response.toolCalls.length > 0
      ? "toolUse"
      : "stop";

  return {
    message: {
      role: "assistant",
      content,
      api: FAUX_API,
      provider: FAUX_PROVIDER,
      model: FAUX_MODEL_ID,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reason,
      errorMessage: response.error,
      timestamp: Date.now(),
    },
    reason,
  };
}

/** A one-shot stream carrying a complete message. Deltas are not simulated; no pin needs them. */
function streamFor(response: ScriptedResponse) {
  const stream = createAssistantMessageEventStream();
  const { message, reason } = buildMessage(response);
  const start: AssistantMessageEvent = {
    type: "start",
    partial: { ...message, content: [], stopReason: "pending" },
  };
  const emit = () => {
    stream.push(start);
    if (reason === "error") {
      stream.push({ type: "error", reason, error: message });
      return;
    }
    stream.push({ type: "done", reason, message });
  };
  queueMicrotask(emit);
  return stream;
}

/** The fake model, used both for the session's selection and for the provider's catalog entry. */
const FAUX_MODEL: Model<typeof FAUX_API> = {
  id: FAUX_MODEL_ID,
  name: "Faux",
  api: FAUX_API,
  provider: FAUX_PROVIDER,
  baseUrl: "http://localhost:0",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

let themeReady = false;

/**
 * pi's theme singleton, initialized once as a real session's startup does. The `ui: false` context is
 * pi's own no-op UI context, whose `theme` reads that singleton, so it has to be set for a styled
 * status to work there. Reachable only through its module (`initTheme` comes from the root), so a pi
 * release that moves it fails `tsc` here instead of quietly styling nothing.
 */
function piTheme(): ExtensionUIContext["theme"] {
  if (!themeReady) {
    initTheme("dark");
    themeReady = true;
  }
  return theme;
}

/** The text an extension wrote, without the theme's escape codes. */
export function plain(text: string | undefined): string | undefined {
  return text === undefined ? undefined : stripVTControlCharacters(text);
}

function createUI(
  answers: HarnessAnswers,
  theme: ExtensionUIContext["theme"],
): { state: HarnessUIState; ui: ExtensionUIContext } {
  const state: HarnessUIState = {
    notifications: [],
    statuses: [],
    dialogs: [],
    status: (key) => state.statuses.filter((entry) => entry.key === key).at(-1)?.text,
  };

  const next = <T>(queue: T[] | undefined, fallback: T): T => queue?.shift() ?? fallback;

  const ui = {
    theme,
    notify: (message: string, type: "info" | "warning" | "error" = "info") => {
      state.notifications.push({ message, type });
    },
    setStatus: (key: string, text: string | undefined) => {
      state.statuses.push({ key, text });
    },
    setWidget: () => {},
    setWorkingMessage: () => {},
    select: async (title: string, options: string[]) => {
      state.dialogs.push({ kind: "select", title, options });
      return next(answers.select, undefined);
    },
    confirm: async (title: string, message: string) => {
      state.dialogs.push({ kind: "confirm", title, message });
      return next(answers.confirm, false);
    },
    input: async (title: string, placeholder: string | undefined) => {
      state.dialogs.push({ kind: "input", title, message: placeholder ?? "" });
      return next(answers.input, undefined);
    },
    editor: async (title: string, prefill: string | undefined) => {
      state.dialogs.push({ kind: "editor", title, message: prefill ?? "" });
      return next(answers.editor, undefined);
    },
    custom: async <T>(factory: unknown) => {
      state.dialogs.push({ kind: "custom" });
      const queue = answers.custom;
      if (!queue || queue.length === 0) {
        throw new Error(
          "the harness has no terminal: pass `ui: { custom: [...] }` to answer a custom component, or test the component directly",
        );
      }
      void factory;
      return queue.shift() as T;
    },
    onTerminalInput: () => () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    getEditorComponent: () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getTheme: () => piTheme(),
    getAllThemes: () => [{ name: "dark", path: undefined }],
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } satisfies ExtensionUIContext;

  return { state, ui };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  let root: string | undefined;
  const removeRoot = () => {
    if (!root) return;
    // Cleared only after the removal, so a failure leaves the path for a later attempt.
    rmSync(root, { recursive: true, force: true });
    root = undefined;
  };

  try {
    // Before the UI choice: pi's startup initializes its theme for every mode, and the no-op UI
    // context that `ui: false` binds reads that singleton rather than holding a theme of its own.
    piTheme();
    root = mkdtempSync(join(tmpdir(), HARNESS_ROOT_PREFIX));
    const agentDir = join(root, "agent");
    const cwd = options.cwd ?? join(root, "cwd");
    // A supplied cwd is the test's own directory: create it only if the test did not.
    for (const dir of [agentDir, ...(options.cwd ? [] : [cwd])]) mkdirSync(dir, { recursive: true });

    const contexts: TranscriptContext[] = [];
    const responses = (options.responses ?? ["ok"]).map(normalize);
    if (responses.length === 0) throw new Error("createHarness needs at least one scripted response");
    let calls = 0;

    const provider: ExtensionFactory = (pi) => {
      pi.registerProvider(FAUX_PROVIDER, {
        baseUrl: FAUX_MODEL.baseUrl,
        apiKey: "faux-key",
        api: FAUX_API,
        models: [FAUX_MODEL],
        streamSimple: (_model, context) => {
          contexts.push(context);
          const response = responses[calls % responses.length];
          calls++;
          return streamFor(response);
        },
      });
    };

    const settingsManager = SettingsManager.inMemory(options.settings);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      extensionFactories: [provider, ...(options.extensions ?? [])],
    });
    await resourceLoader.reload();

    // Explicit runtime: temp credentials, no models.json, no catalog refresh. See the file header.
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: FAUX_MODEL,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      tools: options.tools,
    });

    const events: AgentSessionEvent[] = [];
    const uiState = options.ui === false ? undefined : createUI(options.ui ?? {}, theme);
    type Waiter = {
      match: (event: AgentSessionEvent) => boolean;
      resolve: (event: AgentSessionEvent) => void;
      timer: ReturnType<typeof setTimeout>;
    };
    const waiters: Waiter[] = [];

    const unsubscribe = session.subscribe((event) => {
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (!waiter.match(event)) continue;
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    });

    // A host binds the UI after creating the session, and that binding is what emits `session_start`:
    // without it an extension's start handler never runs, and the session looks healthy anyway.
    await session.bindExtensions(uiState ? { uiContext: uiState.ui, mode: "tui" } : { mode: "print" });

    const harness: Harness = {
      session,
      ui: uiState?.state,
      cwd,
      root,
      events,
      eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[] {
        return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
      },
      modelContexts: contexts,
      modelCalls: () => calls,
      toolResults: () =>
        events
          .filter(
            (event): event is Extract<AgentSessionEvent, { type: "tool_execution_end" }> =>
              event.type === "tool_execution_end",
          )
          .map((event) => ({ toolName: event.toolName, result: event.result, isError: event.isError })),
      lastText: () => session.getLastAssistantText(),
      run: async (text) => {
        const from = events.length;
        await session.prompt(text);
        // `prompt` resolves after a failed turn too, and it also resolves after pi retries one, so only
        // the run's *last* assistant message decides: a recovered retry is a successful run.
        const produced = events.slice(from);
        for (let i = produced.length - 1; i >= 0; i--) {
          const event = produced[i];
          if (event.type !== "message_end" || event.message.role !== "assistant") continue;
          if (event.message.stopReason === "error") {
            throw new Error(`the scripted turn failed: ${event.message.errorMessage ?? "no error message"}`);
          }
          break;
        }
      },
      waitForEvent: (match, waitOptions) =>
        new Promise<AgentSessionEvent>((resolve, reject) => {
          // Only events after this call, unless the caller asks for the log: a wide predicate that also
          // matched an earlier run would resolve immediately with an event that proves nothing.
          if (waitOptions?.includePast) {
            const existing = events.find(match);
            if (existing) {
              resolve(existing);
              return;
            }
          }
          const description = waitOptions?.description ?? "matching event";
          const timer = setTimeout(() => {
            const index = waiters.findIndex((waiter) => waiter.timer === timer);
            if (index >= 0) waiters.splice(index, 1);
            reject(new Error(`timed out after ${waitOptions?.timeoutMs ?? 10000}ms waiting for ${description}`));
          }, waitOptions?.timeoutMs ?? 10000);
          timer.unref?.();
          waiters.push({ match, resolve, timer });
        }),
      cleanup: () => {
        unsubscribe();
        session.dispose();
        removeRoot();
      },
    };

    return harness;
  } catch (error) {
    try {
      removeRoot();
    } catch {
      // A failure to clean up must not replace the failure that caused it.
    }
    throw error;
  }
}
