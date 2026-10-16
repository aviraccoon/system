/**
 * Repo-agent trust for the session: once the confirmation is accepted for a
 * repository, later dispatches of its repo agents skip it. The acceptance is
 * recorded in the session as a custom entry and restored from the session
 * branch on start, so a reload or resume does not re-ask. Persistent per-repo
 * trust is deliberately not stored here.
 *
 * Pure, so the decision and its session-history round trip are testable
 * without a pi harness.
 */

/** Custom session entry type carrying one accepted repo root in `data.root`. */
export const PROJECT_TRUST_ENTRY = "subagent_project_trust";

/** Structural subset of a pi session entry — enough to rebuild the set. */
export interface TrustHistoryEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Source of session entries for the restore — structural subset of pi's
 * ReadonlySessionManager. */
export interface SessionBranchSource {
  getBranch(): readonly TrustHistoryEntry[];
}

export class AcceptedRoots {
  private readonly roots = new Set<string>();

  has(root: string): boolean {
    return this.roots.has(root);
  }

  add(root: string): void {
    this.roots.add(root);
  }

  /**
   * Rebuild from the session branch: a new session contributes nothing, and a
   * fork created before the acceptance re-asks because the accepted entry is
   * not on the fork's branch. Takes the session rather than entries so the
   * source cannot be swapped for the compaction-filtered context at the call
   * site.
   */
  restoreFromSession(session: SessionBranchSource): void {
    this.roots.clear();
    for (const entry of session.getBranch()) {
      if (entry?.type !== "custom" || entry.customType !== PROJECT_TRUST_ENTRY) continue;
      const root = (entry.data as { root?: unknown } | undefined)?.root;
      if (typeof root === "string") this.roots.add(root);
    }
  }
}
