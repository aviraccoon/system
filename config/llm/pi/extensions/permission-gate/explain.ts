/**
 * Pure logic for the explain/verdict system.
 * No pi imports — testable independently.
 */

import type { ExplanationResult, ExplanationVerdict } from "./confirm-ui";

// ── Tool call description ──

/** Build a concise description of a tool call for the sidecar explainer. */
export function describeToolCall(toolName: string, input: Record<string, unknown>, rawDiff?: string): string {
  if (toolName === "bash") {
    return `bash command: ${input.command}`;
  }
  if (toolName === "write") {
    if (rawDiff) return `write to ${input.path}:\n${rawDiff}`;
    const content = typeof input.content === "string" ? input.content : "";
    return `write to ${input.path}:\n${content}`;
  }
  if (toolName === "edit" || toolName === "patch") {
    if (rawDiff) return `${toolName} ${input.path}:\n${rawDiff}`;
    if (input.edits && Array.isArray(input.edits)) {
      const edits = input.edits as Array<{ oldText?: string; newText?: string; path?: string }>;
      const summary = edits
        .map((e, i) => {
          const old = typeof e.oldText === "string" ? e.oldText : "";
          const nw = typeof e.newText === "string" ? e.newText : "";
          const at = typeof e.path === "string" ? ` @ ${e.path}` : "";
          return `${toolName} ${i + 1}: "${old}" -> "${nw}"${at}`;
        })
        .join("\n");
      return `${toolName} ${input.path} (${edits.length} edits):\n${summary}`;
    }
    const old = typeof input.oldText === "string" ? input.oldText : "";
    const nw = typeof input.newText === "string" ? input.newText : "";
    return `${toolName} ${input.path}: "${old}" -> "${nw}"`;
  }
  return `${toolName}: ${JSON.stringify(input).slice(0, 500)}`;
}

/** First per-edit path for a patch-style input (no top-level path). */
function firstEditPath(input: Record<string, unknown>): string | undefined {
  if (!Array.isArray(input.edits)) return undefined;
  const first = input.edits[0] as { path?: unknown } | undefined;
  return typeof first?.path === "string" ? first.path : undefined;
}

/** One-line target for note attribution: the command or path, whitespace-collapsed and clipped. */
export function noteTarget(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const raw =
    typeof i.command === "string"
      ? i.command
      : typeof i.path === "string"
        ? i.path
        : (firstEditPath(i) ?? describeToolCall(toolName, i));
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 99)}...` : oneLine;
}

/**
 * User message for a confirm-dialog note: the user's words verbatim, plus a
 * trailing attribution so the model knows which tool call it refers to when
 * several were queued in one turn.
 */
export function noteMessage(note: string, toolName: string, input: unknown): string {
  return `${note}\n\n[note on the ${toolName} call: ${noteTarget(toolName, input)}]`;
}

/** Join the notes captured in one turn into a single user message. */
export function notesMessage(notes: string[]): string {
  return notes.join("\n\n");
}

// ── Verdict parsing ──

/** Parse a verdict word from the start of text. */
export function parseVerdict(text: string): ExplanationVerdict | null {
  const upper = text.toUpperCase();
  if (upper.startsWith("DANGEROUS")) return "dangerous";
  if (upper.startsWith("RISKY")) return "risky";
  if (upper.startsWith("SAFE")) return "safe";
  return null;
}

/** Strip a leading verdict word and delimiter from text. */
export function stripVerdictPrefix(text: string): string {
  return text.replace(/^(SAFE|RISKY|DANGEROUS)\s*[|:\-–]\s*/i, "").trim();
}

/**
 * Find the best verdict in a sidecar response.
 *
 * Some models reason out loud and produce a verdict at the end instead of
 * the beginning. We check the first line first (standard format), then
 * fall back to the last non-empty line. If both have verdicts and they
 * disagree, the last one wins (the model's final judgment).
 */
export function findVerdictLine(text: string): { verdict: ExplanationVerdict; line: string; lineIdx: number } | null {
  const lines = text.split("\n");
  let firstResult: { verdict: ExplanationVerdict; line: string; lineIdx: number } | null = null;

  // Check first line
  const firstVerdict = parseVerdict(lines[0]);
  if (firstVerdict) {
    firstResult = { verdict: firstVerdict, line: lines[0], lineIdx: 0 };
  }

  // Check last non-empty line
  for (let i = lines.length - 1; i >= 1; i--) {
    const trimmedLine = lines[i].trim();
    if (!trimmedLine) continue;
    const lastVerdict = parseVerdict(trimmedLine);
    if (lastVerdict) {
      return { verdict: lastVerdict, line: trimmedLine, lineIdx: i };
    }
    break; // Only check the very last non-empty line
  }

  return firstResult;
}

/**
 * Parse a sidecar response into verdict + short + detail.
 * Returns null if no verdict could be parsed and strict mode is on.
 * Strict mode is used for auto-classify where parse failure should
 * fall through to the confirmation dialog, not auto-allow.
 */
export function parseExplanation(text: string, strict: true): ExplanationResult | null;
export function parseExplanation(text: string, strict?: false): ExplanationResult;
export function parseExplanation(text: string, strict?: boolean): ExplanationResult | null {
  const trimmed = text.trim();

  // Find the best verdict — first line, or last non-empty line if the model
  // reasoned out loud and put its final verdict at the end.
  const found = findVerdictLine(trimmed);
  if (!found) {
    if (strict) return null;
    // Non-strict: treat entire first line as the short description, default safe
    const firstNewline = trimmed.indexOf("\n");
    const firstLine = firstNewline === -1 ? trimmed : trimmed.slice(0, firstNewline);
    const detail = firstNewline === -1 ? "" : trimmed.slice(firstNewline + 1).trim();
    return { verdict: "risky", short: firstLine, detail };
  }

  const lines = trimmed.split("\n");
  let detail: string;
  let short: string;
  if (found.lineIdx === 0) {
    // Standard format: verdict on first line, detail after
    short = stripVerdictPrefix(found.line) || found.line;
    detail = lines.slice(1).join("\n").trim();
  } else {
    // Model reasoned then verdicted: detail is the reasoning, short from verdict line
    short = stripVerdictPrefix(found.line) || found.line;
    detail = lines.slice(0, found.lineIdx).join("\n").trim();
  }

  return { verdict: found.verdict, short, detail };
}

// ── Block reason ──

/** Build a block reason from the sidecar explanation. User notes are delivered
 * separately as user messages — instructions inside a tool result read as
 * untrusted to the model. */
export function blockReason(explanation: ExplanationResult | null, toolName?: string, tirithNote?: string): string {
  const verb =
    toolName === "bash"
      ? "The command was NOT executed."
      : toolName === "edit" || toolName === "patch"
        ? "The file was NOT modified."
        : toolName === "write"
          ? "The file was NOT written."
          : "The action was NOT performed.";
  const lines = [`BLOCKED by user. ${verb} Do not retry unless the user asks.`];
  if (explanation) {
    lines.push(`[Automated command classification: ${explanation.verdict.toUpperCase()} — ${explanation.short}]`);
  }
  if (tirithNote) lines.push(tirithNote);
  return lines.join("\n");
}
