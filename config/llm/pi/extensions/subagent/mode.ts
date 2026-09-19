/**
 * Mode resolution for the subagent tool. A one-item `tasks` batch runs as single
 * mode: the parallel path shows only "Parallel: N/M done" while it works, the
 * single path streams the live feed, and the call header reads single mode. An
 * item with an empty agent or task stays a one-item parallel batch.
 *
 * `chain` is checked only to keep the collapse out of an already-invalid call;
 * chain runs in index.ts.
 */

export interface TaskSpec {
  agent: string;
  task: string;
  cwd?: string;
}

export interface ModeResolution {
  /** Tasks for the parallel path; undefined when a one-item batch collapsed to single. */
  parallelTasks?: TaskSpec[];
  /** The single-mode run: explicit params, or the collapsed lone task. */
  singleAgent?: string;
  singleTask?: string;
  singleCwd?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asSpecs(value: unknown): TaskSpec[] | undefined {
  return Array.isArray(value) ? (value as TaskSpec[]) : undefined;
}

/**
 * Resolve what the call runs as. Takes the raw params (typed schema or a TUI
 * args record) and narrows them: a one-item batch collapses to single unless
 * `agent` + `task` or a `chain` is also present (the caller then fails its
 * exactly-one-mode check) or the item's agent or task is empty.
 */
export function resolveMode(params: {
  agent?: unknown;
  task?: unknown;
  cwd?: unknown;
  tasks?: unknown;
  chain?: unknown;
}): ModeResolution {
  const agent = asString(params.agent);
  const task = asString(params.task);
  const tasks = asSpecs(params.tasks);
  const chain = asSpecs(params.chain);

  const lone =
    !chain?.length && !(agent && task) && tasks?.length === 1 && tasks[0]?.agent && tasks[0]?.task
      ? tasks[0]
      : undefined;

  return {
    parallelTasks: lone ? undefined : tasks,
    singleAgent: lone?.agent ?? agent,
    singleTask: lone?.task ?? task,
    // A lone batch uses the item's cwd; the top-level `cwd` applies only to
    // explicit single calls.
    singleCwd: lone ? lone.cwd : asString(params.cwd),
  };
}
