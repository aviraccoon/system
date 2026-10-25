/**
 * Pi permission gate extension.
 *
 * Thin UI wrapper around the decision logic in ./logic.ts.
 * See the README for details.
 */

import { homedir } from "node:os";
import { type ExtensionAPI, type ExtensionContext, renderDiff } from "@earendil-works/pi-coding-agent";
import { computePatchPreview } from "../patch/preview";
import {
  adviceInterception,
  adviceNoteText,
  adviceQuestions,
  adviceScores,
  SHELL_ADVICES,
  withAdviceScores,
} from "../shared/advisory";
import { DEFAULT_DECISIONS_MODEL, decisionsComplete } from "../shared/decisions";
import { EDIT_LIKE_TOOLS } from "../shared/edit-tools";
import { extractText, getSidecarStats, hasRole, resolveProviderAuth, sidecarComplete } from "../shared/model-roles";
import { decisionFromAnswers, RISK_FACTORS, SEVERITY_QUESTION } from "../shared/risk-factors";
import { isConfinedBash } from "../shared/sandbox";
import { isShellTool } from "../shared/shell-tools";
import { computeEditPreview, computeWritePreview } from "./edit-preview";
import type { ExplanationResult } from "./logic";
import { resolveResultNote } from "./result-notes";

/** Preview couldn't be computed (load/computation failure). Distinct from
 *  `undefined` (doomed edit) so the gate fails CLOSED, not silently allows. */
type PatchPreviewUnavailable = { unavailable: true; reason: string };
function isPatchPreviewUnavailable(r: unknown): r is PatchPreviewUnavailable {
  return r != null && typeof r === "object" && "unavailable" in r;
}

import {
  type ConfirmResult,
  type ConfirmUIOptions,
  createConfirmUI,
  type DetailsBody,
  type DiffBody,
  type ExplanationProvider,
  type TirithBanner,
} from "./confirm-ui";
import {
  applyEditFloor,
  blockReason,
  classificationEntry,
  classifierInput,
  describeToolCall,
  factorsToExplanation,
  mergeExplanations,
  nonInteractiveBlockReason,
  noteMessage,
  notesMessage,
  parseExplanation,
} from "./explain";
import { collectFacts, hasContainerFacts } from "./facts";
import {
  autoResolve,
  createInitialState,
  decide,
  findGitRoot,
  type GateState,
  hasShellEscalation,
  MODE_CYCLE,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  MODE_SHORT,
  sensitiveReadDecision,
  statusText,
  stripShellPreamble,
  suggestPrefix,
} from "./logic";
import { EXPLAIN_SYSTEM_PROMPT } from "./prompts";
import {
  applySettings,
  currentSettings,
  loadSettings,
  type PersistedSettings,
  saveSettings,
  settingsPath,
} from "./settings";
import { checkCommand, detectTirith, formatFindingSummary, type TirithReport, tirithFact, tirithFloor } from "./tirith";

/**
 * Decisions-model classifier. The battery and policy live in shared/risk-factors.ts,
 * shared with the benchmarks; the chat explain role is the fallback, so a
 * provider outage or an incomplete answer set degrades to the previous behavior.
 * PI_JEV=off disables the decisions path entirely. The provider must be one the
 * roles config references, because pi resolves its credential through the model
 * registry.
 */
const DECISIONS_PROVIDER = process.env.PI_JEV_PROVIDER ?? "openrouter";
const DECISIONS_MODEL = process.env.PI_JEV_MODEL ?? DEFAULT_DECISIONS_MODEL;
const decisionsEnabled = process.env.PI_JEV !== "off";

/** Mode and auto-classify live here between runs; everything else stays in memory. */
const SETTINGS_PATH = settingsPath(homedir());

export default function permissionGate(pi: ExtensionAPI) {
  const state: GateState = createInitialState();
  // A missing, unreadable or malformed file leaves the fresh defaults. The read
  // happens once per process; session_start keeps the pair on purpose, since it is
  // a preference rather than a session rule.
  applySettings(state, loadSettings(SETTINGS_PATH));

  /**
   * Change a preference and record it. The write lives here rather than at each call
   * site: a toggle that forgets it would work until the next start with nothing to
   * show for it. A failed write leaves the session's choice in force.
   */
  function setPreferences(ctx: ExtensionContext, patch: PersistedSettings) {
    applySettings(state, patch);
    if (!saveSettings(SETTINGS_PATH, currentSettings(state))) {
      ctx.ui.notify("Permission settings were not saved; this session keeps them", "warning");
    }
  }

  /** Notes captured this turn, flushed together as one user message. */
  const pendingNotes: string[] = [];

  /** The notes for a result: everything staged, plus what a dialog-path
   *  classification still owes. They belong to this result — there is no later
   *  one to put them on. */
  async function resultNotesFor(toolCallId: string): Promise<string | undefined> {
    const staged = pendingResultNotes.get(toolCallId);
    pendingResultNotes.delete(toolCallId);
    const inFlight = pendingAdviceNotes.get(toolCallId);
    pendingAdviceNotes.delete(toolCallId);
    return await resolveResultNote(staged, inFlight);
  }

  /**
   * Queue a dialog note as a user message. A note embedded in a tool result
   * reads as untrusted third-party content to the model, so the user's words go
   * in a user turn. Notes are batched and sent at turn end: pi's default
   * steering mode delivers one steer message per assistant turn, so sending
   * them one by one would make every note after the first arrive a turn late.
   * Each block carries an attribution naming the call it refers to.
   */
  function queueNote(note: string, event: { toolName: string; input: unknown }): void {
    pendingNotes.push(noteMessage(note, event.toolName, event.input));
  }

  /** Send queued notes as one user message: steer delivers it after this turn's
   * tool results and before the next LLM call. */
  function flushNotes(): void {
    if (pendingNotes.length === 0) return;
    const text = notesMessage(pendingNotes);
    pendingNotes.length = 0;
    pi.sendUserMessage(text, { deliverAs: "steer" });
  }
  let explainEnabled = false;
  /** At least one classifier backend exists (decisions model or explain role). */
  let classifierAvailable = false;
  /** Latest auto-allow verdict for the widget. Cleared each agent turn. */
  let lastVerdict: string | null = null;

  /** tirith availability (detected at session start) + report cache (per-command). */
  let tirithAvailable = false;
  const tirithCache = new Map<string, TirithReport>();
  /** Notes the classifier stages for a call's result, keyed by call id. */
  const pendingResultNotes = new Map<string, string[]>();
  /** A dialog-path classification's notes, still in flight while the user answers
   *  and the tool runs — the only way they can be computed after the fact. */
  const pendingAdviceNotes = new Map<string, Promise<string | undefined>>();

  /** Run tirith on a bash command, caching reports for repeats (cleared per session). */
  async function runTirithCached(command: string): Promise<TirithReport> {
    const cached = tirithCache.get(command);
    if (cached) return cached;
    const report = await checkCommand(command);
    tirithCache.set(command, report);
    return report;
  }

  function updateWidget(ctx: ExtensionContext) {
    if (state.autoClassify !== "on" || !lastVerdict) {
      ctx.ui.setWidget("permission-gate", undefined);
      return;
    }
    ctx.ui.setWidget("permission-gate", [lastVerdict], { placement: "belowEditor" });
  }

  /**
   * Classify for auto-allow: the decisions model's verdict, and only when that
   * is unavailable the explain role. Deliberately does not wait for prose: the
   * verdict must not queue behind the slower chat model. Takes the state already
   * built for the cache key, so the two can never describe different calls.
   */
  async function classify(
    ctx: ExtensionContext,
    toolName: string,
    description: string,
    containerFacts: boolean,
    timeoutMs = 5000,
  ): Promise<ExplanationResult | null> {
    const factors = await classifyWithFactors(ctx, toolName, description, timeoutMs, undefined, containerFacts);
    if (factors) return applyEditFloor(factors, EDIT_LIKE_TOOLS.includes(toolName));
    const proseText = await askProse(ctx, description, timeoutMs);
    // The prose path gets the same edit floor as the battery: its prompt may
    // call a scratch write safe, and a safe edit-like verdict auto-allows.
    const prose = proseText ? parseExplanation(proseText, true) : null;
    return prose ? applyEditFloor(prose, EDIT_LIKE_TOOLS.includes(toolName)) : null;
  }

  /** Stage a note for a call's result: tirith's fact on an allowed call, or an advice note. */
  function addResultNote(toolCallId: string, note: string): void {
    const existing = pendingResultNotes.get(toolCallId);
    if (existing) existing.push(note);
    else pendingResultNotes.set(toolCallId, [note]);
  }

  /**
   * Append what the classifier said to the session, so thresholds can be tuned
   * against real dialogs later. The user's own choice is not stored here: it is
   * already in the session as the tool result that follows (a block says so).
   */
  function recordClassification(toolName: string, toolCallId: string, result: ExplanationResult | null): void {
    if (!result) return;
    const note = adviceNoteText(result);
    if (note) addResultNote(toolCallId, note);
    pi.appendEntry("permission_gate", classificationEntry(toolName, toolCallId, result));
  }

  /** Ask the explain role for the human sentence. Null on failure or timeout. */
  async function askProse(
    ctx: ExtensionContext,
    description: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await Promise.race([
      sidecarComplete(
        "explain",
        {
          systemPrompt: EXPLAIN_SYSTEM_PROMPT,
          messages: [{ role: "user", content: description, timestamp: Date.now() }],
        },
        ctx.modelRegistry,
        { signal, notify: ctx.ui.notify },
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return result ? extractText(result.message) : null;
  }

  /**
   * Ask the decisions model the factor battery and the severity score. Null when
   * disabled, when the provider has no credential, when any factor or the score
   * is missing (a partial answer set must not read as "nothing fired"), or when
   * the call fails — the verdict then comes from the explain role alone.
   */
  async function classifyWithFactors(
    ctx: ExtensionContext,
    toolName: string,
    description: string,
    timeoutMs: number,
    signal?: AbortSignal,
    containerFacts = false,
  ): Promise<ExplanationResult | null> {
    if (!decisionsEnabled) return null;
    try {
      const auth = await resolveProviderAuth(DECISIONS_PROVIDER, ctx.modelRegistry);
      if (!auth?.apiKey) return null;
      // The shell advices ride the same request: one extra noul each, judged
      // separately from the risk verdict.
      const advices = isShellTool(toolName) ? SHELL_ADVICES : [];
      const questions: Record<string, import("../shared/decisions").DecisionsQuestion> = {
        ...RISK_FACTORS,
        severity: SEVERITY_QUESTION,
        ...adviceQuestions(advices),
      };
      const result = await decisionsComplete(
        { model: DECISIONS_MODEL, state: description, questions },
        { apiKey: auth.apiKey, headers: auth.headers, timeoutMs, signal },
      );
      const decision = decisionFromAnswers(result.answers, { containerFacts });
      if (!decision) return null;
      return withAdviceScores(factorsToExplanation(decision), adviceScores(result.answers, advices));
    } catch {
      return null;
    }
  }

  /**
   * ExplanationProvider for the confirm dialog: factor scores resolve first,
   * then the human sentence merges in when the explain role answers, so the
   * fast classifier is never held up by the slow one.
   */
  function makeExplanation(
    toolName: string,
    input: Record<string, unknown>,
    ctx: ExtensionContext,
    diff?: DiffBody,
    facts?: string,
    containerFacts = false,
  ): ExplanationProvider | undefined {
    if (!explainEnabled) return undefined;

    // The state and its cache key come from one place: an edit-like state depends
    // on the target, so a verdict must not be reused across a change in it.
    const { description, key } = classifierInput(
      toolName,
      input,
      {
        rawDiff: diff?.rawDiff,
        summary: diff?.summary,
      },
      facts,
    );
    // Check cache first -- skip the call if this call was already classified
    const cachedResult = state.classifyCache.get(key);
    if (cachedResult) {
      return { promise: Promise.resolve(cachedResult), abort: () => {} };
    }

    const abortController = new AbortController();
    const listeners: Array<(result: ExplanationResult) => void> = [];

    const factorsPromise = classifyWithFactors(
      ctx,
      toolName,
      description,
      5000,
      abortController.signal,
      containerFacts,
    );
    const prosePromise = askProse(ctx, description, 5000, abortController.signal);

    const promise = (async (): Promise<ExplanationResult | null> => {
      const factors = await factorsPromise;
      if (factors) {
        const floored = applyEditFloor(factors, EDIT_LIKE_TOOLS.includes(toolName));
        state.classifyCache.set(key, { ...floored });
        void prosePromise.then((text) => {
          const prose = text ? parseExplanation(text) : null;
          if (!prose) return;
          const merged = mergeExplanations(floored, prose);
          state.classifyCache.set(key, merged);
          for (const listener of listeners) listener(merged);
        });
        return floored;
      }
      const text = await prosePromise;
      const prose = text ? parseExplanation(text, true) : null;
      // Same floor as classify(): an unfloored safe prose verdict cached here
      // would be auto-allowed verbatim when the identical call is retried.
      const floored = prose ? applyEditFloor(prose, EDIT_LIKE_TOOLS.includes(toolName)) : null;
      if (floored) state.classifyCache.set(key, { ...floored });
      return floored;
    })();

    return {
      promise,
      abort: () => abortController.abort(),
      subscribe: (listener) => listeners.push(listener),
    };
  }

  /** Build an ExplanationProvider from an already-resolved result. */
  function makePreloadedExplanation(result: ExplanationResult): ExplanationProvider {
    return { promise: Promise.resolve(result), abort: () => {} };
  }

  /** Show confirmation dialog with optional inline note. */
  async function confirm(
    ctx: ExtensionContext,
    title: string,
    options: string[],
    explanation?: ExplanationProvider,
    diffBody?: DiffBody,
    detailsBody?: DetailsBody,
    tirith?: TirithBanner,
  ): Promise<ConfirmResult> {
    // In non-TUI modes (rpc/print/json), ctx.ui.custom() returns undefined — no
    // TUI to render the multi-option dialog. Fall back to ctx.ui.confirm(), which
    // works over RPC (relayed to the parent TUI by the subagent extension) and
    // returns a boolean. Can't show diff/explanation or multi-option choices here.
    //
    // Guard on ctx.mode, NOT ctx.hasUI: hasUI is true in RPC mode by design
    // (confirm/select/input work there), but custom() does not. Guarding on
    // !ctx.hasUI skipped this branch in subagents, so confirm() fell through to
    // custom() → undefined → crash in handleDialogAutoToggle (toggledAutoClassify).
    if (ctx.mode !== "tui") {
      const confirmed = await ctx.ui.confirm(title, options.join(", "));
      return { choice: confirmed ? options[0] : null, note: "", explanation: null };
    }

    const uiOptions: ConfirmUIOptions = {
      autoClassify: state.autoClassify === "on",
      hasExplainRole: classifierAvailable,
    };
    return ctx.ui.custom<ConfirmResult>((tui, theme, kb, done) =>
      createConfirmUI(tui, theme, kb, done, title, options, explanation, uiOptions, diffBody, detailsBody, tirith),
    );
  }

  /** Process auto-classify toggle from dialog result. */
  function handleDialogAutoToggle(result: ConfirmResult, ctx: ExtensionContext) {
    if (result.toggledAutoClassify) {
      setPreferences(ctx, { autoClassify: state.autoClassify === "on" ? "off" : "on" });
      ctx.ui.notify(`Auto-classify: ${state.autoClassify}`, "info");
      updateStatus(ctx);
    }
  }

  function updateStatus(ctx: ExtensionContext) {
    const stats = getSidecarStats();
    ctx.ui.setStatus(
      "permission-gate",
      statusText({
        mode: state.mode,
        autoClassify: state.autoClassify,
        classifierAvailable,
        explainEnabled,
        tirithAvailable,
        autoAllowed: state.autoAllowLog.length,
        cost: stats.cost,
      }),
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    // Mode and auto-classify are a preference, restored when the extension loaded;
    // the rules below are session state and start empty.
    state.gitRoot = findGitRoot(ctx.cwd);
    state.allowedBashPrefixes = [];
    state.allowedPaths = [];
    state.allowedPathGlobs = [];
    state.toolOverrides = {};
    state.classifyCache.clear();
    state.autoAllowLog = [];
    classifierAvailable = decisionsEnabled || hasRole("explain");
    explainEnabled = classifierAvailable;
    tirithAvailable = await detectTirith();
    tirithCache.clear();
    pendingResultNotes.clear();
    pendingAdviceNotes.clear();
    pendingNotes.length = 0;
    updateStatus(ctx);
  });

  // Toggle auto-classify
  pi.registerShortcut("ctrl+shift+c", {
    description: "Toggle auto-classify",
    handler: async (ctx) => {
      if (!classifierAvailable) {
        ctx.ui.notify("No classifier: decisions path disabled and no 'explain' role configured", "warning");
        return;
      }
      setPreferences(ctx, { autoClassify: state.autoClassify === "on" ? "off" : "on" });
      updateStatus(ctx);
      ctx.ui.notify(`Auto-classify: ${state.autoClassify}`, "info");
    },
  });

  // Cycle modes
  pi.registerShortcut("ctrl+shift+a", {
    description: "Cycle permission mode",
    handler: async (ctx) => {
      const idx = MODE_CYCLE.indexOf(state.mode);
      setPreferences(ctx, { mode: MODE_CYCLE[(idx + 1) % MODE_CYCLE.length] });
      updateStatus(ctx);
      ctx.ui.notify(`Permissions: ${MODE_LABELS[state.mode]} - ${MODE_SHORT[state.mode]}`, "info");
    },
  });

  // /permissions command
  pi.registerCommand("permissions", {
    description: "Permission gate settings",
    handler: async (_args, ctx) => {
      while (true) {
        let msg = `Current: ${MODE_LABELS[state.mode]}\n`;
        msg += `${MODE_DESCRIPTIONS[state.mode]}\n\n`;
        msg += `Project root: ${state.gitRoot ?? ctx.cwd}${state.gitRoot ? " (git)" : " (no git repo)"}\n\n`;

        msg += "Modes (Ctrl+Shift+A to cycle):\n";
        for (const m of MODE_CYCLE) {
          const marker = m === state.mode ? ">" : " ";
          msg += `  ${marker} ${MODE_LABELS[m]}  ${MODE_SHORT[m]}\n`;
        }

        // Tool overrides
        const overrideTools = ["edit", "patch", "write", "bash"];
        msg += "\nTool rules:\n";
        for (const t of overrideTools) {
          const setting = state.toolOverrides[t] ?? "confirm";
          msg += `  ${t}: ${setting}\n`;
        }

        msg += `\nAuto-classify: ${state.autoClassify}${classifierAvailable ? "" : " (no classifier configured)"}\n`;
        msg += `Explain: ${explainEnabled ? "on" : "off"}${classifierAvailable ? "" : " (no classifier configured)"}\n`;
        const stats = getSidecarStats();
        if (stats.calls > 0) {
          msg += `Sidecar: ${stats.calls} calls, $${stats.cost.toFixed(4)}\n`;
        }
        if (state.autoAllowLog.length > 0) {
          msg += `Auto-allowed: ${state.autoAllowLog.length} calls\n`;
        }

        // Session allows
        const hasAllows =
          state.allowedBashPrefixes.length > 0 || state.allowedPaths.length > 0 || state.allowedPathGlobs.length > 0;
        if (hasAllows) {
          msg += "\nSession allows:\n";
          for (const p of state.allowedBashPrefixes) {
            msg += `  bash prefix: "${p}"\n`;
          }
          for (const p of state.allowedPaths) {
            msg += `  path: ${p}\n`;
          }
          for (const g of state.allowedPathGlobs) {
            msg += `  glob: ${g}\n`;
          }
        }

        const options = [
          "Done",
          `Toggle auto-classify (${state.autoClassify})`,
          "Toggle edit tool (allow/confirm)",
          "Toggle patch tool (allow/confirm)",
          "Toggle write tool (allow/confirm)",
          "Toggle bash tool (allow/confirm)",
          `Toggle explain (${explainEnabled ? "on" : "off"})`,
          "Add path glob rule",
          "Add bash prefix rule",
          ...(state.autoAllowLog.length > 0 ? ["View auto-allow log"] : []),
          ...(hasAllows ? ["Clear all session allows"] : []),
          "Reset to Careful",
        ];

        const choice = await ctx.ui.select(msg, options);

        if (choice === "Done" || choice === undefined) break;

        if (choice?.startsWith("Toggle auto-classify")) {
          if (classifierAvailable) {
            setPreferences(ctx, { autoClassify: state.autoClassify === "on" ? "off" : "on" });
            if (state.autoClassify === "off") {
              lastVerdict = null;
              updateWidget(ctx);
            }
            ctx.ui.notify(`Auto-classify: ${state.autoClassify}`, "info");
            updateStatus(ctx);
          } else {
            ctx.ui.notify("No classifier: decisions path disabled and no 'explain' role configured", "warning");
          }
        } else if (choice === "View auto-allow log") {
          let logMsg = `Auto-allowed calls (${state.autoAllowLog.length}):\n\n`;
          for (const entry of state.autoAllowLog.slice(-20)) {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            logMsg += `  ${time} ${entry.verdict.toUpperCase()} ${entry.toolName}: ${entry.short}\n`;
          }
          if (state.autoAllowLog.length > 20) {
            logMsg += `  ... and ${state.autoAllowLog.length - 20} more\n`;
          }
          await ctx.ui.select(logMsg, ["Back"]);
        } else if (choice === "Toggle edit tool (allow/confirm)") {
          state.toolOverrides.edit = state.toolOverrides.edit === "allow" ? undefined : "allow";
          ctx.ui.notify(`edit: ${state.toolOverrides.edit ?? "confirm"}`, "info");
        } else if (choice === "Toggle patch tool (allow/confirm)") {
          state.toolOverrides.patch = state.toolOverrides.patch === "allow" ? undefined : "allow";
          ctx.ui.notify(`patch: ${state.toolOverrides.patch ?? "confirm"}`, "info");
        } else if (choice === "Toggle write tool (allow/confirm)") {
          state.toolOverrides.write = state.toolOverrides.write === "allow" ? undefined : "allow";
          ctx.ui.notify(`write: ${state.toolOverrides.write ?? "confirm"}`, "info");
        } else if (choice === "Toggle bash tool (allow/confirm)") {
          state.toolOverrides.bash = state.toolOverrides.bash === "allow" ? undefined : "allow";
          ctx.ui.notify(`bash: ${state.toolOverrides.bash ?? "confirm"}`, "info");
        } else if (choice?.startsWith("Toggle explain")) {
          if (classifierAvailable) {
            explainEnabled = !explainEnabled;
            ctx.ui.notify(`Explain: ${explainEnabled ? "on" : "off"}`, "info");
          } else {
            ctx.ui.notify("No classifier: decisions path disabled and no 'explain' role configured", "warning");
          }
        } else if (choice === "Add path glob rule") {
          const glob = await ctx.ui.input("Path glob (e.g. **/*.nix, config/llm/pi/**):");
          if (glob) {
            state.allowedPathGlobs.push(glob);
            ctx.ui.notify(`Added glob: ${glob}`, "info");
          }
        } else if (choice === "Add bash prefix rule") {
          const prefix = await ctx.ui.input("Bash prefix (e.g. bun test, git):");
          if (prefix) {
            state.allowedBashPrefixes.push(prefix);
            ctx.ui.notify(`Added bash prefix: "${prefix}"`, "info");
          }
        } else if (choice === "Clear all session allows") {
          state.allowedBashPrefixes = [];
          state.allowedPaths = [];
          state.allowedPathGlobs = [];
          state.toolOverrides = {};
          ctx.ui.notify("Session allows cleared", "info");
        } else if (choice === "Reset to Careful") {
          setPreferences(ctx, { mode: "careful", autoClassify: "off" });
          state.allowedBashPrefixes = [];
          state.allowedPaths = [];
          state.allowedPathGlobs = [];
          state.toolOverrides = {};
          state.classifyCache.clear();
          state.autoAllowLog = [];
          updateStatus(ctx);
          ctx.ui.notify("Reset to Careful mode", "info");
        }
      }
    },
  });

  /** Build a DetailsBody from tool input for display when there's no diff. */
  function computeDetailsBody(toolName: string, input: Record<string, unknown>): DetailsBody | undefined {
    const desc = describeToolCall(toolName, input);
    const lines = desc.split("\n");
    if (lines.length <= 1 && lines[0]?.length === 0) return undefined;
    return { lines };
  }

  /** Compute a styled diff for the confirm dialog. */
  async function computeDiffBody(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string,
  ): Promise<DiffBody | PatchPreviewUnavailable | undefined> {
    try {
      if (toolName === "edit" && input.edits && Array.isArray(input.edits)) {
        const path = typeof input.path === "string" ? input.path : "";
        const edits = input.edits as Array<{ oldText?: string; newText?: string }>;
        const result = await computeEditPreview(path, edits, cwd);
        // {error} = the tool will reject too (unreadable/not-found/duplicate/
        // overlap/no-change): no styled diff, gate confirms via details body.
        if ("error" in result) return undefined;
        const styled = renderDiff(result.diff);
        return {
          lines: styled.split("\n"),
          rawDiff: result.diff,
          firstChangedLine: result.firstChangedLine,
          summary: result.summary,
        };
      }
      if (toolName === "patch" && input.edits && Array.isArray(input.edits)) {
        const path = typeof input.path === "string" ? input.path : "";
        const edits = input.edits as Array<{
          oldText?: string;
          newText?: string;
          path?: string;
          anchor?: string;
          replaceAll?: boolean;
        }>;
        try {
          const result = await computePatchPreview(path, edits as Parameters<typeof computePatchPreview>[1], cwd);
          // undefined = genuinely doomed (tool will reject, safe to skip). A
          // throw = computation failure → `unavailable` → gate confirms.
          if (!result) return undefined;
          const styled = renderDiff(result.diff);
          return {
            lines: styled.split("\n"),
            rawDiff: result.diff,
            firstChangedLine: result.firstChangedLine,
            summary: result.summary,
          };
        } catch {
          return { unavailable: true, reason: "patch preview computation failed" };
        }
      }
      if (toolName === "write") {
        const content = typeof input.content === "string" ? input.content : "";
        const path = typeof input.path === "string" ? input.path : "";
        const preview = await computeWritePreview(path, content, cwd);
        const styled = renderDiff(preview.diff);
        return {
          lines: styled.split("\n"),
          rawDiff: preview.diff,
          firstChangedLine: preview.firstChangedLine,
          summary: preview.summary,
        };
      }
    } catch {
      // Fall through -- diff is nice-to-have, not critical
    }
    return undefined;
  }

  /** Show the confirmation dialog and process the user's choice. Returns tool_call event result. */
  async function showConfirmDialog(
    ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
    event: { toolName: string; toolCallId: string; input: unknown },
    decision: import("./logic").GateDecision,
    explanation?: ExplanationProvider,
    diffBody?: DiffBody,
    detailsBody?: DetailsBody,
    tirith?: TirithBanner,
    tirithFacts?: string,
  ): Promise<{ block: true; reason: string } | undefined> {
    pi.appendEntry("permission_gate", { event: "pending_confirmation", toolCallId: event.toolCallId });
    explanation?.promise
      .then((result) => recordClassification(event.toolName, event.toolCallId, result))
      .catch(() => {});
    // The notes are computed from this promise; a fast answer can run the tool
    // before it settles, so hand it to the tool_result consumer instead of
    // relying on the `.then` above having run first. Shell calls only: the
    // advices ride the shell battery, so any other tool would wait for nothing.
    if (explanation && isShellTool(event.toolName)) {
      pendingAdviceNotes.set(
        event.toolCallId,
        explanation.promise.then(adviceNoteText, () => undefined),
      );
    }
    if (decision.confirmType === "bash") {
      const prefix = decision.suggestedPrefix ?? "";
      const command = decision.displayPath ?? "";
      // Always show the command in the scrollable body -- even short commands
      // can get truncated by terminal width when combined with the "bash: " prefix
      const bashDiffBody: DiffBody = diffBody ?? { lines: command.split("\n"), rawDiff: "", firstChangedLine: 0 };
      const options = ["Allow once"];
      // An empty prefix would be a dead rule that reports success; offer nothing.
      if (!decision.escalation && prefix.length > 0) {
        options.push(`Allow "${prefix}" for this session`);
      }
      options.push("Allow all bash for this session", "Block");
      const title = decision.escalation ? "bash (compound command)" : "bash";
      const result = await confirm(ctx, title, options, explanation, bashDiffBody, undefined, tirith);
      handleDialogAutoToggle(result, ctx);
      const { choice, note, explanation: explResult } = result;

      if (choice === "Block" || choice === null) {
        if (note) queueNote(note, event);
        // The model hears the finding whether the human allowed or refused: tirith is
        // evidence, and this branch is the only place that knows the human saw it.
        const why = blockReason(explResult, event.toolName);
        return { block: true, reason: tirithFacts ? `${why}\n${tirithFacts}` : why };
      }
      if (choice?.startsWith('Allow "') && choice.endsWith('" for this session')) {
        state.allowedBashPrefixes.push(prefix);
        ctx.ui.notify(`Allowing bash prefix: "${prefix}"`, "info");
      }
      if (choice === "Allow all bash for this session") {
        state.toolOverrides.bash = "allow";
        ctx.ui.notify("Bash allowed for this session", "warning");
      }
      if (note) queueNote(note, event);
      if (tirithFacts) addResultNote(event.toolCallId, tirithFacts);
      return undefined;
    }

    if (decision.confirmType === "sensitive") {
      const path = decision.displayPath ?? "";
      const result = await confirm(
        ctx,
        `Sensitive file: ${path} (${event.toolName})`,
        ["Allow once", `Allow "${path}" for this session`, "Block"],
        explanation,
        diffBody,
        detailsBody,
      );
      handleDialogAutoToggle(result, ctx);
      const { choice, note, explanation: explResult } = result;

      if (choice === "Block" || choice === null) {
        if (note) queueNote(note, event);
        return { block: true, reason: blockReason(explResult, event.toolName) };
      }
      if (choice?.startsWith('Allow "')) {
        state.allowedPaths.push(path);
      }
      if (note) queueNote(note, event);
      return undefined;
    }

    // write, outside-project
    const path = decision.displayPath ?? "";
    const title =
      decision.confirmType === "outside-project"
        ? `${event.toolName} outside project: ${path}`
        : `${event.toolName}: ${path}`;

    const result = await confirm(
      ctx,
      title,
      ["Allow once", `Allow "${path}" for this session`, "Block"],
      explanation,
      diffBody,
      detailsBody,
    );
    handleDialogAutoToggle(result, ctx);
    const { choice, note, explanation: explResult } = result;

    if (choice === "Block" || choice === null) {
      if (note) queueNote(note, event);
      return { block: true, reason: blockReason(explResult, event.toolName) };
    }
    if (choice?.startsWith('Allow "')) {
      state.allowedPaths.push(path);
    }
    if (note) queueNote(note, event);
    return undefined;
  }

  // Main permission gate
  pi.on("tool_call", async (event, ctx) => {
    // A confined bash call needs no decision: reads outside the workspace are
    // allowed, writes are denied, and there is no network, so the gate has nothing
    // to add and tirith's findings are moot for a process that can neither write
    // nor send. The marker names the confined tool, so an unrestricted `bash` in
    // the same session still confirms. See extensions/sandbox-bash.
    if (isConfinedBash(event.toolName)) return undefined;

    let decision = decide(event.toolName, event.input as Record<string, unknown>, ctx.cwd, state);

    // `read` and `grep` run in the agent process, where the seatbelt profile cannot
    // reach: a delegated agent could pull a credential into its context — and from
    // there to the model provider — with no prompt at all. Subagents only; in the
    // main session the user is present and reading those files is deliberate. The
    // child's confirm is relayed to the parent TUI, so this is a prompt, not a
    // silent allow.
    if (process.env.PI_SUBAGENT === "1") {
      const sensitiveRead = sensitiveReadDecision(
        event.toolName,
        event.input as Record<string, unknown>,
        ctx.cwd,
        state,
      );
      if (sensitiveRead) decision = sensitiveRead;
    }
    let tirith: TirithBanner | undefined;
    let tirithFacts: string | undefined;
    let tirithHoldsDecision = false;

    // tirith is a witness, not a judge: its findings go to the classifier as evidence and
    // ride the dialog banner. One exception — a CRITICAL finding is never the classifier's
    // to resolve, so it forces the confirm path, which is a refusal when there is no UI.
    if (event.toolName === "bash" && tirithAvailable) {
      const command = (event.input as Record<string, unknown>).command;
      if (typeof command === "string") {
        const report = await runTirithCached(command);
        if (report.findings.length > 0) {
          tirithFacts = tirithFact(report);
          tirith = { summary: formatFindingSummary(report) };
        }
        tirithHoldsDecision = tirithFloor(report);
        if (tirithHoldsDecision) {
          // A floor needs a banner even with no findings, or the forced dialog looks routine.
          tirith ??= { summary: "blocked with no rule detail" };
          if (decision.action === "allow") {
            decision = {
              action: "confirm",
              confirmType: "bash",
              displayPath: command,
              suggestedPrefix: suggestPrefix(command),
              // Same test the gate's own bash branch uses, so the forced dialog does not
              // offer a broader session allow than the command would get there.
              escalation: hasShellEscalation(stripShellPreamble(command)),
            };
          }
        }
      }
    }

    if (decision.action === "allow") {
      // An allowed call never reaches a classifier, so the finding would be lost. Hand it
      // to the model as a result note instead — that is the blind spot tirith exists for.
      if (tirithFacts) addResultNote(event.toolCallId, tirithFacts);
      return undefined;
    }

    if (decision.action === "block") {
      return { block: true, reason: decision.reason ?? "Blocked by permission gate" };
    }

    // action === "confirm"
    // RPC mode subagents use ctx.ui.confirm()/select()/input() which emit
    // extension_ui_request events. The subagent extension relays these to the
    // parent's TUI and sends back extension_ui_response on stdin.
    const input = event.input as Record<string, unknown>;

    // Compute diff/preview early -- used by the patch bypass, auto-classify,
    // and the confirm dialog. Cheap (file read + matching); needed anyway.
    const diffResult = await computeDiffBody(event.toolName, input, ctx.cwd);
    // Fail CLOSED: `unavailable` (preview failed) → confirm without a diff;
    // `undefined` (doomed edit) → skip. Only doomed edits skip confirmation.
    let diffBody: DiffBody | undefined;
    let patchPreviewUnavailable = false;
    if (isPatchPreviewUnavailable(diffResult)) {
      patchPreviewUnavailable = true;
      diffBody = undefined;
    } else {
      diffBody = diffResult;
    }
    // A preview with no diff text (an unreadable target) still carries the summary
    // the classifier needs, but there is nothing to render — the dialog falls back
    // to the tool input instead of an empty box.
    const renderableDiff = diffBody?.rawDiff ? diffBody : undefined;
    const detailsBody = renderableDiff ? undefined : computeDetailsBody(event.toolName, input);

    // patch: skip only dry runs + doomed edits (no write happens). If preview
    // was unavailable, fall through to confirm without a diff — never allow.
    // Runs before the hasUI check so dryRun/doomed skip works in -p mode.
    if (event.toolName === "patch") {
      const isDryRun = (input as Record<string, unknown>).dryRun === true;
      if (isDryRun) return undefined;
      if (!patchPreviewUnavailable && !diffBody) return undefined; // doomed edit
      if (patchPreviewUnavailable) {
        ctx.ui.notify("patch preview unavailable — confirming without diff", "warning");
      }
    }

    if (!ctx.hasUI) {
      const reason = nonInteractiveBlockReason(event.toolName);
      // A floor still owes the model the reason it was stopped.
      return { block: true, reason: tirithFacts ? `${reason}\n${tirithFacts}` : reason };
    }

    // Facts about the world the call reaches, appended to the classifier's state.
    // tirith reads the command's text; these read the container it names, which is what
    // tells a delete in a container's own layer from one through a bind mount.
    const worldFacts = await collectFacts({ toolName: event.toolName, input });
    const containerFacts = hasContainerFacts(worldFacts);
    const classifierFacts = [worldFacts, tirithFacts].filter(Boolean).join("\n\n") || undefined;

    // Auto-classify: call sidecar before showing dialog. Resolution composes the
    // deterministic decision with the verdict (autoResolve), so a floor the gate
    // set is not the classifier's to resolve. Runs supervised only — the /auto
    // trigger that selects the unattended bands is not wired yet.
    if (state.autoClassify === "on" && classifierAvailable && !tirithHoldsDecision) {
      const { description, key } = classifierInput(
        event.toolName,
        input,
        {
          rawDiff: diffBody?.rawDiff,
          summary: diffBody?.summary,
        },
        classifierFacts,
      );
      const cached = state.classifyCache.get(key);
      const resolve = (result: ExplanationResult) =>
        autoResolve(decision, { verdict: result.verdict, short: result.short }, state.mode, "supervised");
      const autoAllow = (result: ExplanationResult, tag: string) => {
        recordClassification(event.toolName, event.toolCallId, result);
        state.autoAllowLog.push({
          toolName: event.toolName,
          description,
          verdict: result.verdict,
          short: result.short,
          timestamp: Date.now(),
        });
        lastVerdict = `${result.verdict.toUpperCase()}${tag} ${event.toolName}: ${result.short}`;
        updateWidget(ctx);
        updateStatus(ctx);
      };

      if (cached) {
        const resolution = resolve(cached);
        const advised = adviceInterception(cached.advices, resolution.action);
        if (advised) {
          recordClassification(event.toolName, event.toolCallId, cached);
          return { block: true, reason: advised.reason };
        }
        if (resolution.action === "allow") {
          autoAllow(cached, " (cached)");
          return undefined;
        }
        if (resolution.action === "block") return { block: true, reason: resolution.reason };
        return await showConfirmDialog(
          ctx,
          event,
          decision,
          makePreloadedExplanation(cached),
          renderableDiff,
          detailsBody,
          tirith,
          tirithFacts,
        );
      }

      ctx.ui.setWorkingMessage("Classifying...");
      const explResult = await classify(ctx, event.toolName, description, containerFacts);
      ctx.ui.setWorkingMessage();

      if (explResult) {
        state.classifyCache.set(key, { ...explResult });
        const resolution = resolve(explResult);
        const advised = adviceInterception(explResult.advices, resolution.action);
        if (advised) {
          recordClassification(event.toolName, event.toolCallId, explResult);
          return { block: true, reason: advised.reason };
        }
        if (resolution.action === "allow") {
          autoAllow(explResult, "");
          return undefined;
        }
        if (resolution.action === "block") return { block: true, reason: resolution.reason };
        // Not auto-allowed -- fall through to dialog with pre-loaded explanation
        return await showConfirmDialog(
          ctx,
          event,
          decision,
          makePreloadedExplanation(explResult),
          renderableDiff,
          detailsBody,
          tirith,
          tirithFacts,
        );
      }
      // Sidecar failed or parse failure -- fall through to normal dialog
    }

    // Normal path: build explanation provider (fires concurrently with dialog).
    // tirith's findings ride the banner above it; the sidecar explanation states what the
    // command actually does, which is what the human needs to judge it.
    const explanation = makeExplanation(event.toolName, input, ctx, diffBody, classifierFacts, containerFacts);
    return await showConfirmDialog(ctx, event, decision, explanation, renderableDiff, detailsBody, tirith, tirithFacts);
  });

  // Flush notes captured during the turn as one user message: this runs after
  // the turn's tool results and before the next LLM call, so every note from a
  // turn lands together instead of one per assistant turn.
  pi.on("turn_end", async () => {
    // Leftovers belong to a blocked or interrupted call. Keyed by call id, they
    // cannot reach another result, so this is only about not growing the maps.
    pendingResultNotes.clear();
    pendingAdviceNotes.clear();
    flushNotes();
  });

  // Clear widget when agent turn ends
  pi.on("agent_end", async (_event, ctx) => {
    flushNotes();
    lastVerdict = null;
    updateWidget(ctx);
  });

  // Append advisory notes to tool results so the model sees them.
  // Also refresh status bar (sidecar cost may have changed).
  pi.on("tool_result", async (event, ctx) => {
    if (explainEnabled) updateStatus(ctx);
    const note = await resultNotesFor(event.toolCallId);
    if (!note) return undefined;
    return {
      content: [...event.content, { type: "text" as const, text: `\n\n${note}` }],
    };
  });
}
