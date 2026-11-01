/**
 * What `/jobs` shows: a scope, a state filter, and the record of which session started a job.
 *
 * The default is the project's running jobs. `project` is the default scope because a job is built
 * to outlive pi, and a session id dies with the session that owned it, so a session default would
 * show an empty list exactly when a lost build needs finding.
 */

import { type JobView, jobState } from "./format";

export type JobScope = "project" | "session" | "all";

/** One key cycles the three scopes, so the state is always reachable without a menu. */
export function cycleScope(scope: JobScope): JobScope {
  if (scope === "project") return "session";
  if (scope === "session") return "all";
  return "project";
}

export function scopeLabel(scope: JobScope): string {
  if (scope === "project") return "this project";
  if (scope === "session") return "this session";
  return "all dirs";
}

export interface ScopeContext {
  cwd?: string;
  sessionId?: string;
}

export function inScope(view: JobView, scope: JobScope, context: ScopeContext): boolean {
  if (scope === "all") return true;
  if (scope === "session") return startedHere(view, context.sessionId);
  return context.cwd === undefined ? true : view.cwd === context.cwd;
}

/**
 * Whether this session started the job. A record from before the field existed belongs to no
 * session, so it is nobody's: it can be read and killed by selection, but a bulk action leaves it.
 */
export function startedHere(view: JobView, sessionId: string | undefined): boolean {
  return view.session !== undefined && view.session === sessionId;
}

export interface FilterOptions extends ScopeContext {
  scope: JobScope;
  /** Off by default: finished records live for days and would bury the running ones. */
  showFinished: boolean;
}

export function visibleJobs(views: JobView[], options: FilterOptions): JobView[] {
  return views.filter((view) => {
    if (!inScope(view, options.scope, options)) return false;
    return options.showFinished || jobState(view.status, view.alive).kind === "running";
  });
}

/**
 * How many settled jobs the filter hides, so an empty list can offer the key instead of being a
 * dead end. Counted inside the scope, since a filter is only confusing about what it can reveal.
 */
export function hiddenFinished(views: JobView[], options: ScopeContext & { scope: JobScope }): number {
  return views.filter(
    (view) => inScope(view, options.scope, options) && jobState(view.status, view.alive).kind !== "running",
  ).length;
}
