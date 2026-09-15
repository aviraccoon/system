/**
 * Pure content scanning for edit-guard: run a rule set over file content and
 * format violations. No pi imports — test with bun.
 */

import type { CompiledPathRule, ContentRule } from "./rules";

export interface Violation {
  /** 1-indexed line number. */
  line: number;
  /** The offending line, as written. */
  text: string;
  /** Labels of the rules this line matched. */
  labels: string[];
}

export function scanContent(content: string, rules: ContentRule[]): Violation[] {
  const violations: Violation[] = [];
  for (const [i, line] of content.split("\n").entries()) {
    const labels = rules.filter((r) => r.pattern.test(line)).map((r) => r.label);
    if (labels.length > 0) violations.push({ line: i + 1, text: line, labels });
  }
  return violations;
}

const MAX_SHOWN = 15;

/**
 * Format violations as a self-contained block: header with rule name and
 * count, per-line `>>` context (line numbers alone are ambiguous to agents),
 * then the verbatim policy statement.
 */
export function formatViolations(violations: Violation[], rule: CompiledPathRule, relPath: string): string {
  const shown = violations.slice(0, MAX_SHOWN);
  const lines = [
    `[edit-guard ${rule.displayName}${relPath ? ` ${relPath}` : ""}: ${violations.length} suspect line${violations.length === 1 ? "" : "s"}]`,
  ];
  for (const v of shown) {
    lines.push(`  L${v.line} (${v.labels.join(", ")})`);
    lines.push(`  >> ${v.text}`);
  }
  if (violations.length > shown.length) {
    lines.push(`  ... and ${violations.length - shown.length} more`);
  }
  lines.push("");
  lines.push(rule.policy);
  return lines.join("\n");
}
