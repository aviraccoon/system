/**
 * Block-once state for bash-kind rules: the first matching command of a
 * session is refused, every later one passes. Pure, so the decision and its
 * session-history round trip are testable without a pi harness.
 *
 * The refusal is recorded in the session as a custom entry and restored from
 * the session branch on start, so a reload or resume (which re-instantiates
 * the extension) does not re-arm a rule the agent already saw. The branch, not
 * the compaction-filtered context: a refusal written before a compaction must
 * survive it.
 */

import type { CompiledPathRule } from "./rules";
import { scanContent, type Violation } from "./scan";

/** Custom session entry type carrying one blocked rule name in `data.blocked`. */
export const BLOCK_ONCE_ENTRY = "edit_guard_block_once";

/** Structural subset of a pi session entry — enough to rebuild the set. */
export interface BlockOnceHistoryEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Source of session entries for the restore — structural subset of pi's
 * ReadonlySessionManager. */
export interface SessionBranchSource {
  getBranch(): readonly BlockOnceHistoryEntry[];
}

export class BlockOnceSet {
  private readonly blocked = new Set<string>();

  /**
   * The rule's violations when this command is the rule's first match of the
   * session — the rule is recorded — and null when it is not a blockOnce rule,
   * does not match, or was already blocked.
   */
  claim(rule: CompiledPathRule, command: string): Violation[] | null {
    if (rule.kind !== "bash" || rule.enforce !== "blockOnce") return null;
    if (this.blocked.has(rule.displayName)) return null;
    const violations = scanContent(command, rule.rules);
    if (violations.length === 0) return null;
    this.blocked.add(rule.displayName);
    return violations;
  }

  /** Rule names already blocked, in insertion order. */
  names(): string[] {
    return [...this.blocked];
  }

  /**
   * Rebuild from the session branch: a new session contributes nothing, and
   * entries on abandoned branches are not part of the input. Takes the session
   * rather than entries so the source cannot be swapped for the
   * compaction-filtered context at the call site.
   */
  restoreFromSession(session: SessionBranchSource): void {
    this.blocked.clear();
    for (const entry of session.getBranch()) {
      if (entry?.type !== "custom" || entry.customType !== BLOCK_ONCE_ENTRY) continue;
      const blocked = (entry.data as { blocked?: unknown } | undefined)?.blocked;
      if (typeof blocked === "string") this.blocked.add(blocked);
    }
  }
}
