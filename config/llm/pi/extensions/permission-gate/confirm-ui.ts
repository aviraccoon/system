/**
 * Custom confirmation UI for the permission gate.
 *
 * Shows a select list with an optional note input.
 * Tab switches focus between the list and the note field.
 * Enter confirms the selected action with the note attached.
 *
 * Optionally shows an LLM-generated explanation of the tool call:
 * - Short summary shown by default
 * - Ctrl+E toggles full explanation
 * - Streams in while the user is reading/deciding (zero added latency)
 */

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager } from "@earendil-works/pi-tui";
import { Container, Editor, matchesKey, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { ScrollableText } from "../shared/scrollable-text";
import type { RiskVerdict } from "./logic";

export interface ConfirmResult {
  choice: string | null;
  note: string;
  /** The explanation result, if available by the time the user decided. */
  explanation: ExplanationResult | null;
  /** Whether the user toggled auto-classify from within the dialog. */
  toggledAutoClassify?: boolean;
}

export type ExplanationVerdict = RiskVerdict;

export interface ExplanationResult {
  verdict: ExplanationVerdict;
  short: string;
  detail: string;
}

export interface ExplanationProvider {
  /** Resolves with the first usable result (factor scores when available). */
  promise: Promise<ExplanationResult | null>;
  /** Abort the in-flight request. */
  abort: () => void;
  /** Later, richer results — e.g. prose arriving after the factor scores. */
  subscribe?: (listener: (result: ExplanationResult) => void) => void;
}

export interface ConfirmUIOptions {
  /** Whether auto-classify is currently enabled. Shown in help text. */
  autoClassify?: boolean;
  /** Whether the explain role is available (controls whether Ctrl+A hint shows). */
  hasExplainRole?: boolean;
}

/** Pre-computed diff lines for display in the confirm dialog. */
export interface DiffBody {
  /** Styled lines (ANSI-colored). */
  lines: string[];
  /** Raw diff text (no ANSI, for sidecar classification). */
  rawDiff: string;
  /** One-line account of the change (create/overwrite, line counts) for classification. */
  summary?: string;
  /** Index of the first changed line (for initial scroll position in compact view). */
  firstChangedLine?: number;
}

/** Formatted tool input for display when there's no diff (e.g., subagent, web_search). */
export interface DetailsBody {
  /** Lines to display (pre-formatted, no ANSI needed). */
  lines: string[];
  /** Whether to show the header line "── Tool Input ──". */
  showHeader?: boolean;
}

export function createConfirmUI(
  tui: TUI,
  theme: Theme,
  _kb: KeybindingsManager,
  done: (result: ConfirmResult) => void,
  title: string,
  options: string[],
  explanation?: ExplanationProvider,
  uiOptions?: ConfirmUIOptions,
  diffBody?: DiffBody,
  detailsBody?: DetailsBody,
  tirithWarning?: string,
): Component {
  const blockIndex = options.length - 1; // "Block" is always last
  const container = new Container();
  type Focus = "list" | "note" | "diff";
  let focus: Focus = "list";
  let explanationState: "loading" | "ready" | "expanded" | "none" = explanation ? "loading" : "none";
  let explanationResult: ExplanationResult | null = null;
  let didToggleAutoClassify = false;

  // Diff display state
  const COMPACT_LINES = 6;
  const FULL_MAX_LINES = 30;
  let diffExpanded = false;

  function nextFocus(): Focus {
    const targets: Focus[] = ["list", "note"];
    if (diffExpanded && scrollable?.scrollable) targets.push("diff");
    const idx = targets.indexOf(focus);
    return targets[(idx + 1) % targets.length];
  }

  // Title
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
  container.addChild(new Text(theme.fg("accent", title), 1, 0));

  // Diff body (scrollable, shown between title and explanation)
  const scrollable = diffBody
    ? new ScrollableText(diffBody.lines, COMPACT_LINES, {
        scrollHint: (t) => theme.fg("dim", t),
        border: (t) => theme.fg("borderMuted", t),
      })
    : null;
  if (scrollable) {
    // Start compact view at the first change with 1 line of context above
    if (diffBody?.firstChangedLine !== undefined && diffBody.firstChangedLine > 1) {
      scrollable.setScrollOffset(diffBody.firstChangedLine - 1);
    }
    container.addChild({
      render: (w: number) => scrollable.render(w),
      invalidate: () => scrollable.invalidate(),
    });
  }

  function updateDiffView() {
    if (!scrollable || !diffBody) return;
    if (diffExpanded) {
      scrollable.setMaxHeight(Math.min(FULL_MAX_LINES, diffBody.lines.length));
    } else {
      scrollable.setMaxHeight(COMPACT_LINES);
    }
  }

  // Details text (shown below explanation, for non-diff tools like subagent/web_search)
  const DETAILS_LINES = 8;
  const detailsScrollable = detailsBody
    ? new ScrollableText(detailsBody.lines, DETAILS_LINES, {
        scrollHint: (t) => theme.fg("dim", t),
        border: (t) => theme.fg("borderMuted", t),
      })
    : null;
  const detailsHeader =
    detailsBody && detailsBody.showHeader !== false ? new Text(theme.fg("dim", "── Tool Input ──"), 0, 0) : null;
  if (detailsScrollable) {
    if (detailsHeader) container.addChild(detailsHeader);
    container.addChild({
      render: (w: number) => detailsScrollable.render(w),
      invalidate: () => detailsScrollable.invalidate(),
    });
  }

  // tirith finding: styled banner above the explanation (block=red, warn=yellow).
  // Distinct from the command body and the sidecar verdict — three assessments,
  // each in its place.
  if (tirithWarning) {
    const sev: "error" | "warning" | "dim" =
      tirithWarning.startsWith("[HIGH]") || tirithWarning.startsWith("[CRITICAL]")
        ? "error"
        : tirithWarning.startsWith("[MEDIUM]")
          ? "warning"
          : "dim";
    container.addChild(new Text(theme.fg(sev, `tirith ${tirithWarning}`), 1, 0));
  }

  // Explanation text (shown between diff/details and select list)
  const explanationText = new Text("", 1, 0);
  container.addChild(explanationText);

  function updateExplanationDisplay() {
    if (explanationState === "none") {
      explanationText.setText("");
      return;
    }
    if (explanationState === "loading") {
      explanationText.setText(theme.fg("dim", "Explaining..."));
      return;
    }
    if (!explanationResult) return;

    const themeColor =
      explanationResult.verdict === "dangerous"
        ? ("error" as const)
        : explanationResult.verdict === "risky"
          ? ("warning" as const)
          : ("success" as const);
    const tag = explanationResult.verdict.toUpperCase();
    const shortLine = theme.fg(themeColor, `${tag}: ${explanationResult.short}`);

    if (explanationState === "expanded") {
      explanationText.setText(`${shortLine}\n${theme.fg("dim", explanationResult.detail)}`);
    } else {
      const hint = explanationResult.detail ? theme.fg("dim", "  [Ctrl+E]") : "";
      explanationText.setText(`${shortLine}${hint}`);
    }
  }

  // Kick off explanation loading
  if (explanation) {
    updateExplanationDisplay();
    // A later result (prose after the factor scores) replaces what is shown
    // without disturbing the verdict default set from the first result.
    explanation.subscribe?.((result) => {
      explanationResult = result;
      if (explanationState === "none") explanationState = "ready";
      updateExplanationDisplay();
      updateLabels();
      tui.requestRender();
    });
    explanation.promise
      .then((result) => {
        if (result) {
          explanationResult = result;
          explanationState = "ready";
          // Default selection based on verdict
          if (result.verdict === "dangerous") {
            selectList.setSelectedIndex(blockIndex);
          }
          // SAFE and RISKY default to index 0 (Allow once), which is already the default
        } else {
          explanationState = "none";
        }
        updateExplanationDisplay();
        updateLabels();
        tui.requestRender();
      })
      .catch(() => {
        explanationState = "none";
        updateExplanationDisplay();
        tui.requestRender();
      });
  }

  // Select list
  const items: SelectItem[] = options.map((opt) => ({ value: opt, label: opt }));
  const selectList = new SelectList(items, Math.min(items.length, 8), {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  });

  function finish(choice: string | null) {
    explanation?.abort();
    done({
      choice,
      note: (lastSubmittedNote || noteInput.getText()).trim(),
      explanation: explanationResult,
      toggledAutoClassify: didToggleAutoClassify || undefined,
    });
  }

  selectList.onSelect = (item) => finish(item.value);
  selectList.onCancel = () => finish(null);
  container.addChild(selectList);

  // tirith HIGH → default cursor to Block (strongest-signal-wins with the sidecar:
  // stays Block even if the sidecar later resolves SAFE, since the sidecar only
  // moves the cursor on DANGEROUS, never resets it).
  if (tirithWarning?.startsWith("[HIGH]") || tirithWarning?.startsWith("[CRITICAL]")) {
    selectList.setSelectedIndex(blockIndex);
  }

  // Note input (multi-line: Shift+Enter for newlines, Enter confirms)
  const noteLabel = new Text("", 1, 0);
  container.addChild(noteLabel);

  const noteInput = new Editor(tui, {
    borderColor: (s: string) => theme.fg("borderMuted", s),
    selectList: {
      selectedPrefix: (t) => t,
      selectedText: (t) => t,
      description: (t) => t,
      scrollInfo: (t) => t,
      noMatch: (t) => t,
    },
  });
  // Editor.submitValue() clears internal state before calling onSubmit,
  // so we capture the submitted text from the callback argument.
  let lastSubmittedNote = "";
  noteInput.onSubmit = (text: string) => {
    lastSubmittedNote = text;
    const selected = selectList.getSelectedItem();
    if (selected) finish(selected.value);
  };
  container.addChild(noteInput);

  // Help
  const helpText = new Text("", 1, 0);
  container.addChild(helpText);
  container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

  function updateLabels() {
    const explainHint = explanationState === "ready" && explanationResult?.detail ? "Ctrl+E detail  |  " : "";
    const currentAuto = (uiOptions?.autoClassify ?? false) !== didToggleAutoClassify;
    const autoHint = uiOptions?.hasExplainRole ? `Ctrl+A auto:${currentAuto ? "on" : "off"}  |  ` : "";
    const diffHint = scrollable ? `Ctrl+O ${diffExpanded ? "compact" : "full"} diff  |  ` : "";
    noteLabel.setText(focus === "note" ? theme.fg("accent", "Note: ") : theme.fg("dim", "Note: "));
    const tabTarget = nextFocus();
    helpText.setText(
      theme.fg("dim", `${diffHint}${explainHint}${autoHint}Tab ${tabTarget}  |  Enter confirm  |  Esc cancel`),
    );
  }
  updateLabels();

  return {
    render: (w: number) => container.render(w),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => {
      // Ctrl+O to toggle diff view
      if (matchesKey(data, "ctrl+o") && scrollable && diffBody) {
        diffExpanded = !diffExpanded;
        // Expanding: focus the diff. Collapsing: return to list.
        focus = diffExpanded ? "diff" : "list";
        updateDiffView();
        updateLabels();
        tui.requestRender();
        return;
      }

      // Ctrl+E to toggle detail
      if (matchesKey(data, "ctrl+e") && (explanationState === "ready" || explanationState === "expanded")) {
        explanationState = explanationState === "ready" ? "expanded" : "ready";
        updateExplanationDisplay();
        updateLabels();
        tui.requestRender();
        return;
      }

      // Ctrl+A to toggle auto-classify
      if (matchesKey(data, "ctrl+a") && uiOptions?.hasExplainRole) {
        didToggleAutoClassify = !didToggleAutoClassify;
        updateLabels();
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "tab")) {
        focus = nextFocus();
        updateLabels();
        tui.requestRender();
        return;
      }

      if (focus === "diff" && scrollable) {
        if (scrollable.handleInput(data)) {
          tui.requestRender();
          return;
        }
        // Enter/Esc still work from diff focus
        if (matchesKey(data, "return")) {
          const selected = selectList.getSelectedItem();
          if (selected) finish(selected.value);
          return;
        }
        if (matchesKey(data, "escape")) {
          finish(null);
          return;
        }
      } else if (focus === "note") {
        if (matchesKey(data, "escape")) {
          finish(null);
          return;
        }
        // Editor handles Enter (submit via onSubmit) and Shift+Enter (newline)
        noteInput.handleInput(data);
      } else {
        selectList.handleInput(data);
      }
      tui.requestRender();
    },
  };
}
